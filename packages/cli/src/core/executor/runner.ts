/**
 * The step runner — the checkpoint protocol apply and resume share:
 *
 *   abort check → expectation re-check → step.intent (before-hashes, backups)
 *   → [crash point after-intent] → effect → [crash point after-effect]
 *   → step.done (after-hashes, created paths, log) → state.json snapshot
 *
 * Intent is durable before any byte changes, completion after; whatever
 * happens in between (crash, SIGINT, failure) leaves a journal from which
 * resume can tell exactly which step was in flight. Failures are recorded
 * (step.failed + operation.failed, or operation.interrupted) before they
 * propagate, so the on-disk state always explains how the run ended.
 */
import { schemaUrl } from "../contracts/common.ts";
import {
  type OperationResult,
  type PathHashes,
  OperationResult as ResultSchema,
} from "../contracts/operation.ts";
import type { OperationPlan, PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error, toErrorInfo } from "../errors.ts";
import type { CoreContext, EventInput } from "../runtime.ts";
import { crashPoint } from "./crash.ts";
import { staleError } from "./freshness.ts";
import { backupKeys, currentHash, hashKeys, parseKey } from "./fsops.ts";
import { Journal, type OperationPaths, progressOf, type Replay } from "./journal.ts";
import { SecretBook, secretRefs } from "./secrets.ts";
import { abortReason, type StepContext, type StepEffect } from "./step-context.ts";
import { runEffect, stepFindings, trackedKeys } from "./steps.ts";
import { stepStates, writeState } from "./store.ts";

export interface Execution {
  readonly sc: StepContext;
  readonly journal: Journal;
}

export function createExecution(
  ctx: CoreContext,
  root: string,
  plan: OperationPlan,
  paths: OperationPaths,
): Execution {
  const journal = Journal.open(paths.journal);
  const sc: StepContext = {
    ctx,
    root,
    plan,
    operationId: paths.id,
    paths,
    secrets: new SecretBook(root, secretRefs(plan)),
    produced: (byStep, path) => {
      const done = progressOf(journal.replay(), byStep).done;
      return done === null ? undefined : done.after[path];
    },
  };
  return { sc, journal };
}

/** Write the state.json snapshot for the journal as it stands. */
export function checkpoint(ex: Execution): Replay {
  const replayed = ex.journal.replay();
  writeState(ex.sc.paths, ex.sc.plan, replayed);
  return replayed;
}

export function emit(ex: Execution, event: Omit<EventInput, "operationId">): void {
  ex.sc.ctx.events.emit({ ...event, operationId: ex.sc.operationId });
}

/** Paths a step created: tracked keys absent before and present after, plus parent dirs. */
function createdPaths(before: PathHashes, after: PathHashes, extra: readonly string[]): string[] {
  const fromKeys = Object.keys(after)
    .filter((key) => after[key] !== null && (before[key] ?? null) === null)
    .map((key) => parseKey(key).path);
  return [...new Set([...extra, ...fromKeys])].filter((path) => path !== ".");
}

/** Journal step.done for an effect (filling after-hashes for any tracked key it didn't report). */
export async function completeStep(
  ex: Execution,
  action: PlannedAction,
  before: PathHashes,
  effect: StepEffect,
): Promise<void> {
  const after: PathHashes = { ...effect.after };
  for (const key of Object.keys(before)) {
    if (!(key in after)) after[key] = await currentHash(ex.sc.root, key);
  }
  ex.journal.append({
    type: "step.done",
    stepId: action.id,
    outcome: effect.outcome,
    after,
    created: createdPaths(before, after, effect.created),
    logRef: effect.logRef,
  });
  checkpoint(ex);
  // Human mode shows each step as it starts; completion is only news when it
  // wasn't a plain "applied" (reconciled / already applied).
  emit(ex, {
    type: "step.done",
    level: effect.outcome === "applied" ? "debug" : "info",
    stepId: action.id,
    message: `${action.id} ${effect.outcome}: ${action.description}`,
    data: { outcome: effect.outcome, logRef: effect.logRef },
  });
}

function boundaryInterrupt(ex: Execution, nextStep: string): GrootV2Error {
  const signal = abortReason(ex.sc.ctx.signal);
  return new GrootV2Error(
    "GROOT_E_INTERRUPTED",
    `Interrupted (${signal}) before step ${nextStep}.`,
    {
      details: { stepId: null, nextStep, signal },
    },
  );
}

/** Journal the intent (before-hashes + backups) of a step about to run. */
export async function recordIntent(ex: Execution, action: PlannedAction): Promise<PathHashes> {
  const keys = trackedKeys(ex.sc.root, action);
  const before = await hashKeys(ex.sc.root, keys);
  const backups = backupKeys(ex.sc.root, ex.sc.paths, action.id, keys, ex.sc.secrets);
  ex.journal.append({ type: "step.intent", stepId: action.id, before, backups });
  checkpoint(ex);
  return before;
}

/** One step through the full checkpoint protocol. */
export async function executeStep(ex: Execution, action: PlannedAction): Promise<void> {
  if (ex.sc.ctx.signal.aborted) throw boundaryInterrupt(ex, action.id);
  const findings = await stepFindings(ex.sc, action);
  if (findings.length > 0) {
    throw staleError(findings, {
      planId: ex.sc.plan.planId,
      operationId: ex.sc.operationId,
      stepId: action.id,
    });
  }
  const before = await recordIntent(ex, action);
  emit(ex, {
    type: "step.started",
    level: "info",
    stepId: action.id,
    message: `${action.id} ${action.description}`,
    data: { type: action.type },
  });
  crashPoint(ex.sc.ctx.env, action.id, "after-intent");
  const effect = await runEffect(ex.sc, action);
  crashPoint(ex.sc.ctx.env, action.id, "after-effect");
  await completeStep(ex, action, before, effect);
}

function enrich(error: unknown, operationId: string, stepId: string | null): GrootV2Error {
  const info = toErrorInfo(error);
  const hint =
    info.id === "GROOT_E_INTERRUPTED"
      ? `Completed steps are kept; continue with \`groot resume ${operationId}\`.`
      : (info.hint ??
        `Fix the cause, then \`groot resume ${operationId}\` — or undo completed steps with \`groot rollback ${operationId}\`.`);
  return new GrootV2Error(info.id, info.message, {
    hint,
    details: { ...(info.details ?? {}), operationId, stepId },
  });
}

/**
 * Record how a run ended badly — interrupted, or failed (with the in-flight
 * step marked failed) — then return the error to throw, carrying the
 * operation id and a resume/rollback hint.
 */
export function recordFailure(ex: Execution, error: unknown): GrootV2Error {
  const info = toErrorInfo(error);
  const stepId = ex.journal.replay().currentStep;
  if (info.id === "GROOT_E_INTERRUPTED") {
    ex.journal.append({
      type: "operation.interrupted",
      stepId,
      signal: abortReason(ex.sc.ctx.signal),
    });
    emit(ex, {
      type: "operation.interrupted",
      level: "warn",
      stepId,
      message: `Interrupted — resume with \`groot resume ${ex.sc.operationId}\`.`,
    });
  } else {
    if (stepId !== null) {
      const logRef = info.details?.logRef;
      ex.journal.append({
        type: "step.failed",
        stepId,
        error: info,
        logRef: typeof logRef === "string" ? logRef : null,
      });
    }
    ex.journal.append({ type: "operation.failed", error: info });
    emit(ex, { type: "operation.failed", level: "error", stepId, message: info.message });
  }
  checkpoint(ex);
  return enrich(error, ex.sc.operationId, stepId);
}

export function operationResult(
  ex: Execution,
  options: { alreadyApplied?: boolean; nextSteps?: readonly string[] } = {},
): OperationResult {
  const replayed = ex.journal.replay();
  return ResultSchema.parse({
    $schema: schemaUrl("operation-result"),
    schemaVersion: 1,
    kind: "groot.operation-result",
    operationId: ex.sc.operationId,
    planId: ex.sc.plan.planId,
    status: replayed.status,
    alreadyApplied: options.alreadyApplied ?? false,
    steps: stepStates(ex.sc.plan, replayed),
    evidence: [...replayed.evidence],
    nextSteps: [...(options.nextSteps ?? [])],
    error: replayed.error,
  });
}

/**
 * Run every step that hasn't completed, then journal completion. Any failure
 * is recorded before it propagates.
 */
export async function runRemaining(ex: Execution): Promise<OperationResult> {
  try {
    for (const action of ex.sc.plan.actions) {
      if (progressOf(ex.journal.replay(), action.id).phase === "done") continue;
      await executeStep(ex, action);
    }
  } catch (error) {
    throw recordFailure(ex, error);
  }
  ex.journal.append({ type: "operation.completed", evidence: [] });
  checkpoint(ex);
  emit(ex, {
    type: "operation.completed",
    level: "info",
    message: `Operation ${ex.sc.operationId} completed (${ex.sc.plan.actions.length} steps).`,
  });
  return operationResult(ex, {
    nextSteps: [`groot rollback ${ex.sc.operationId} --dry-run`],
  });
}
