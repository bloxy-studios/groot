/**
 * resumeOperation — continue an interrupted, crashed, or failed operation
 * from its journal.
 *
 * Completed steps are never repeated. The one step that was in flight
 * (intent journaled, no completion) is reconciled against its postcondition
 * before anything runs:
 * - file steps: current == planned result → done ("reconciled"); current ==
 *   journaled before → re-run; anything else → GROOT_E_CONFLICT naming it;
 * - commands: idempotent ones re-run; others are never re-run blindly —
 *   GROOT_E_BLOCKED until a human chooses --retry-step or --skip-step;
 * - generators: a promoted destination → done; otherwise clean and re-run;
 * - secrets: re-run (only appends when the variable is still missing).
 * A re-run reuses the ORIGINAL intent (before-hashes and backups), so a
 * partially applied first attempt never becomes rollback's baseline.
 * Pending steps then run with their own expectations re-checked, so human
 * edits made during the interruption surface as a narrow GROOT_E_STALE_PLAN.
 */

import { readdirSync } from "node:fs";
import type { OperationResult, OperationStatus, PathHashes } from "../contracts/operation.ts";
import type { PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { acquireProjectLock } from "../fs/lock.ts";
import { resolveInProject } from "../fs/paths.ts";
import type { CoreContext } from "../runtime.ts";
import { STATE_DIR_NAME } from "../state.ts";
import { crashPoint } from "./crash.ts";
import { hashKeys, parseKey, pathKind } from "./fsops.ts";
import type { IntentRecord, Replay } from "./journal.ts";
import { realRoot } from "./project.ts";
import {
  checkpoint,
  completeStep,
  createExecution,
  type Execution,
  emit,
  recordFailure,
  runRemaining,
} from "./runner.ts";
import { abortReason } from "./step-context.ts";
import { isFileStep, plannedAfter, runEffect } from "./steps.ts";
import { cleanProduced } from "./steps-process.ts";
import { isResumableStatus, loadOperation, observedStatus } from "./store.ts";
import type { ResumeOptions } from "./types.ts";

type Settlement =
  | {
      readonly kind: "done";
      readonly after: PathHashes;
      readonly outcome: "reconciled" | "already-applied";
    }
  | { readonly kind: "rerun"; readonly cleanup?: () => void };

interface Unfinished {
  readonly action: PlannedAction;
  readonly intent: IntentRecord;
}

function notResumable(operationId: string, status: OperationStatus): GrootV2Error {
  const rollingBack = status === "rolling-back" || status === "rollback-conflicted";
  return new GrootV2Error(
    "GROOT_E_NOT_RESUMABLE",
    `Operation ${operationId} is ${status}; there is nothing to resume.`,
    {
      hint: rollingBack
        ? `Finish the rollback with \`groot rollback ${operationId}\`.`
        : `Inspect it with \`groot status ${operationId}\`.`,
      details: { operationId, status },
    },
  );
}

/** The step whose intent was journaled without completion (in flight or failed). */
function unfinishedStep(actions: readonly PlannedAction[], replayed: Replay): Unfinished | null {
  for (const action of actions) {
    const progress = replayed.steps.get(action.id);
    if (progress === undefined || progress.intent === null) continue;
    if (progress.phase === "in-flight" || progress.phase === "failed") {
      return { action, intent: progress.intent };
    }
  }
  return null;
}

function assertStepOptions(
  options: ResumeOptions,
  unfinished: Unfinished | null,
  operationId: string,
): void {
  for (const [flag, value] of [
    ["--retry-step", options.retryStep],
    ["--skip-step", options.skipStep],
  ] as const) {
    if (value === undefined || value === unfinished?.action.id) continue;
    throw new GrootV2Error(
      "GROOT_E_USAGE",
      unfinished === null
        ? `${flag} ${value}: operation ${operationId} has no interrupted step.`
        : `${flag} ${value}: the interrupted step is ${unfinished.action.id}.`,
      { details: { operationId, step: value, interrupted: unfinished?.action.id ?? null } },
    );
  }
}

function blocked(ex: Execution, action: PlannedAction, why: string): GrootV2Error {
  const id = ex.sc.operationId;
  return new GrootV2Error(
    "GROOT_E_BLOCKED",
    `Step ${action.id} (${action.description}) was interrupted mid-run and ${why}.`,
    {
      hint: `If it did not take effect: \`groot resume ${id} --retry-step ${action.id}\`. If it did: \`groot resume ${id} --skip-step ${action.id}\`.`,
      // `gate` tells surfaces this is the retry/skip decision (not, e.g., a missing adapter).
      details: { operationId: id, stepId: action.id, gate: "interrupted-step" },
    },
  );
}

/** File steps: compare every tracked key with the planned result and with the journaled before. */
async function settleFileStep(ex: Execution, unfinished: Unfinished): Promise<Settlement> {
  const { action, intent } = unfinished;
  const planned = plannedAfter(ex.sc, action, intent);
  const keys = [...new Set([...Object.keys(intent.before), ...Object.keys(planned ?? {})])];
  const current = await hashKeys(ex.sc.root, keys);
  if (planned !== null && keys.every((key) => current[key] === (planned[key] ?? null))) {
    return { kind: "done", after: current, outcome: "reconciled" };
  }
  if (keys.every((key) => current[key] === (intent.before[key] ?? null))) return { kind: "rerun" };
  const changed = keys
    .filter((key) => current[key] !== (intent.before[key] ?? null))
    .filter((key) => planned === null || current[key] !== (planned[key] ?? null))
    .map((key) => parseKey(key).path);
  throw new GrootV2Error(
    "GROOT_E_CONFLICT",
    `Step ${action.id} was interrupted and ${changed.join(", ")} now matches neither its state before the step nor the step's result.`,
    {
      hint: `Someone changed it meanwhile. Restore it (or undo completed steps with \`groot rollback ${ex.sc.operationId}\`).`,
      details: { operationId: ex.sc.operationId, stepId: action.id, paths: changed },
    },
  );
}

function hasContent(root: string, path: string): boolean {
  const abs = resolveInProject(root, path);
  if (pathKind(abs) !== "dir") return pathKind(abs) !== "absent";
  return readdirSync(abs).some((entry) => entry !== STATE_DIR_NAME);
}

async function settle(
  ex: Execution,
  unfinished: Unfinished,
  options: ResumeOptions,
): Promise<Settlement> {
  const { action, intent } = unfinished;
  if (options.skipStep === action.id) {
    return {
      kind: "done",
      after: await hashKeys(ex.sc.root, Object.keys(intent.before)),
      outcome: "already-applied",
    };
  }
  if (isFileStep(action)) return settleFileStep(ex, unfinished);
  const retry = options.retryStep === action.id;
  switch (action.type) {
    case "command.run":
      if (action.idempotent || retry) return { kind: "rerun" };
      throw blocked(ex, action, "is not safe to repeat blindly");
    case "generator.run": {
      const key = Object.keys(intent.before)[0] ?? "";
      const existedBefore = (intent.before[key] ?? null) !== null;
      // Staged output is promoted by one rename: present means complete.
      if (action.mode === "staged" && !retry && hasContent(ex.sc.root, action.produces)) {
        return { kind: "done", after: await hashKeys(ex.sc.root, [key]), outcome: "reconciled" };
      }
      return {
        kind: "rerun",
        cleanup: () => cleanProduced(ex.sc.root, action.produces, existedBefore),
      };
    }
    case "internal": {
      const current = await hashKeys(ex.sc.root, Object.keys(intent.before));
      const untouched = Object.keys(intent.before).every(
        (key) => current[key] === intent.before[key],
      );
      if (untouched || retry) return { kind: "rerun" };
      throw blocked(ex, action, "already changed the files it touches");
    }
    default:
      // env.secret only appends a missing variable; external is refused again by its effect.
      return { kind: "rerun" };
  }
}

/** Re-run an unfinished step under its ORIGINAL intent (before-hashes + backups). */
async function rerun(ex: Execution, unfinished: Unfinished, settlement: Settlement): Promise<void> {
  const { action, intent } = unfinished;
  if (ex.sc.ctx.signal.aborted) {
    throw new GrootV2Error(
      "GROOT_E_INTERRUPTED",
      `Interrupted (${abortReason(ex.sc.ctx.signal)}) before re-running ${action.id}.`,
      {
        details: { stepId: null },
      },
    );
  }
  if (settlement.kind === "rerun") settlement.cleanup?.();
  ex.journal.append({
    type: "step.intent",
    stepId: action.id,
    before: intent.before,
    backups: intent.backups,
  });
  checkpoint(ex);
  emit(ex, {
    type: "step.started",
    level: "info",
    stepId: action.id,
    message: `${action.id} ${action.description} (resumed)`,
  });
  crashPoint(ex.sc.ctx.env, action.id, "after-intent");
  const effect = await runEffect(ex.sc, action);
  crashPoint(ex.sc.ctx.env, action.id, "after-effect");
  const outcome = effect.outcome === "already-applied" ? "reconciled" : effect.outcome;
  await completeStep(ex, action, intent.before, { ...effect, outcome });
}

async function settleUnfinished(
  ex: Execution,
  unfinished: Unfinished,
  settlement: Settlement,
): Promise<void> {
  if (settlement.kind === "rerun") {
    await rerun(ex, unfinished, settlement);
    return;
  }
  await completeStep(ex, unfinished.action, unfinished.intent.before, {
    outcome: settlement.outcome,
    after: settlement.after,
    created: [],
    logRef: null,
  });
}

export async function resumeOperation(
  ctx: CoreContext,
  root: string,
  operationId: string,
  options: ResumeOptions = {},
): Promise<OperationResult> {
  const canonical = realRoot(root);
  const loaded = loadOperation(canonical, operationId);
  const status = observedStatus(canonical, loaded);
  if (!isResumableStatus(status)) throw notResumable(operationId, status);
  assertStepOptions(options, unfinishedStep(loaded.plan.actions, loaded.replayed), operationId);

  const lock = acquireProjectLock(canonical, { command: "resume", operationId });
  try {
    const ex = createExecution(ctx, canonical, loaded.plan, loaded.paths);
    const replayed = ex.journal.replay();
    if (!isResumableStatus(replayed.status)) throw notResumable(operationId, replayed.status);
    const unfinished = unfinishedStep(loaded.plan.actions, replayed);
    assertStepOptions(options, unfinished, operationId);
    // Decide how the in-flight step settles before writing anything: a
    // conflict or a blocked command leaves the operation exactly as it was.
    const settlement = unfinished === null ? null : await settle(ex, unfinished, options);

    ex.journal.append({ type: "operation.resumed", pid: process.pid });
    checkpoint(ex);
    emit(ex, { type: "operation.resumed", level: "info", message: `Resuming ${operationId}.` });
    if (unfinished !== null && settlement !== null) {
      try {
        await settleUnfinished(ex, unfinished, settlement);
      } catch (error) {
        throw recordFailure(ex, error);
      }
    }
    return await runRemaining(ex);
  } finally {
    lock.release();
  }
}
