/**
 * applyPlan — execute a validated plan as a journaled operation.
 *
 * Order matters (docs/v2-architecture.md#execution):
 * 1. validate the document (schema + integrity) and refuse a different root;
 * 2. enforce policy, and refuse plans this build cannot execute at all
 *    (external effects, unknown internal handlers) before touching anything;
 * 3. read-only pre-checks: a completed operation with the same fingerprint
 *    makes this a no-op (`alreadyApplied`), an unfinished one is a conflict
 *    pointing at `groot resume`, and stale preconditions are refused — none
 *    of these write a single byte;
 * 4. take the writer lock and repeat the idempotency and freshness checks
 *    under it (another writer may have finished in between);
 * 5. create the operation directory, journal `operation.started`, and run
 *    the steps through the checkpoint protocol (runner.ts).
 */
import { hostname } from "node:os";
import { schemaUrl } from "../contracts/common.ts";
import type { OperationResult, OperationState } from "../contracts/operation.ts";
import { OperationResult as ResultSchema } from "../contracts/operation.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { acquireProjectLock } from "../fs/lock.ts";
import { newId } from "../ids.ts";
import type { CoreContext } from "../runtime.ts";
import { checkPreconditions, staleError } from "./freshness.ts";
import { internalHandler } from "./handlers.ts";
import { validatePlanDocument } from "./plans.ts";
import { assertPolicy } from "./policy.ts";
import { canonicalRoot } from "./project.ts";
import { checkpoint, createExecution, emit, runRemaining } from "./runner.ts";
import { abortReason } from "./step-context.ts";
import { externalBlocked } from "./steps-process.ts";
import { createOperationDir, findByFingerprint } from "./store.ts";
import type { ApplyRequest } from "./types.ts";

/** Refuse plans that can never run to completion with this build — before any effect. */
function assertExecutable(plan: OperationPlan): void {
  const external = plan.actions.find((action) => action.type === "external");
  if (external?.type === "external") {
    throw externalBlocked(external.provider, external.effect, external.id);
  }
  const missing = plan.actions.filter(
    (action) => action.type === "internal" && internalHandler(action.handler) === undefined,
  );
  if (missing.length > 0) {
    const names = missing.map((action) => (action.type === "internal" ? action.handler : ""));
    throw new GrootV2Error(
      "GROOT_E_INTERNAL",
      `The plan uses internal handlers this groot build does not have: ${names.join(", ")}.`,
      {
        hint: "Re-create the plan with this groot version.",
        details: { handlers: names },
      },
    );
  }
}

function alreadyApplied(ctx: CoreContext, prior: OperationState): OperationResult {
  ctx.events.emit({
    type: "plan.already-applied",
    level: "info",
    operationId: prior.operationId,
    message: `This plan was already applied by ${prior.operationId} — nothing to do.`,
  });
  return ResultSchema.parse({
    $schema: schemaUrl("operation-result"),
    schemaVersion: 1,
    kind: "groot.operation-result",
    operationId: prior.operationId,
    planId: prior.planId,
    status: prior.status,
    alreadyApplied: true,
    steps: prior.steps,
    evidence: prior.evidence,
    nextSteps: [`groot status ${prior.operationId}`],
    error: null,
  });
}

/** An unfinished operation of the same plan must be resumed (or rolled back), not re-applied. */
function unfinishedConflict(prior: OperationState): GrootV2Error {
  const rollingBack = prior.status === "rolling-back" || prior.status === "rollback-conflicted";
  return new GrootV2Error(
    "GROOT_E_CONFLICT",
    `This plan already started as ${prior.operationId} (${prior.status}); applying it again could repeat its effects.`,
    {
      hint: rollingBack
        ? `groot rollback ${prior.operationId}`
        : `groot resume ${prior.operationId}`,
      details: { operationId: prior.operationId, status: prior.status },
    },
  );
}

async function assertFresh(root: string, plan: OperationPlan): Promise<void> {
  const findings = await checkPreconditions(root, plan.preconditions);
  if (findings.length > 0) throw staleError(findings, { planId: plan.planId });
}

/**
 * Idempotency gate: null when the plan should run; an OperationResult when it
 * already completed. `deferRunning` lets a live writer's operation fall
 * through to the lock (which then reports GROOT_E_LOCKED).
 */
function priorOutcome(
  ctx: CoreContext,
  prior: OperationState | null,
  deferRunning: boolean,
): OperationResult | null {
  if (prior === null || prior.status === "rolled-back") return null;
  if (prior.status === "completed") return alreadyApplied(ctx, prior);
  if (prior.status === "running" && deferRunning) return null;
  throw unfinishedConflict(prior);
}

function interruptedBeforeStart(ctx: CoreContext): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_INTERRUPTED",
    `Interrupted (${abortReason(ctx.signal)}) before the operation started; nothing was changed.`,
    {
      details: { stepId: null },
    },
  );
}

export async function applyPlan(ctx: CoreContext, request: ApplyRequest): Promise<OperationResult> {
  const plan = validatePlanDocument(request.plan);
  const root = canonicalRoot(request.root, plan.project.root);
  assertPolicy(plan, request.policy, request.approvals ?? []);
  assertExecutable(plan);

  const early = priorOutcome(ctx, await findByFingerprint(root, plan.fingerprint), true);
  if (early !== null) return early;
  await assertFresh(root, plan);
  if (ctx.signal.aborted) throw interruptedBeforeStart(ctx);

  const operationId = newId("op");
  const lock = acquireProjectLock(root, { command: request.command, operationId });
  try {
    const settled = priorOutcome(ctx, await findByFingerprint(root, plan.fingerprint), false);
    if (settled !== null) return settled;
    await assertFresh(root, plan);

    const ex = createExecution(ctx, root, plan, createOperationDir(root, operationId, plan));
    ex.journal.append({
      type: "operation.started",
      operationId,
      planId: plan.planId,
      planFingerprint: plan.fingerprint,
      pid: process.pid,
      host: hostname(),
      grootVersion: ctx.grootVersion,
    });
    checkpoint(ex);
    emit(ex, {
      type: "operation.started",
      level: "info",
      message: `Applying ${plan.planId} as ${operationId} (${plan.actions.length} step${plan.actions.length === 1 ? "" : "s"}).`,
      data: { planId: plan.planId, command: request.command },
    });
    return await runRemaining(ex);
  } finally {
    lock.release();
  }
}
