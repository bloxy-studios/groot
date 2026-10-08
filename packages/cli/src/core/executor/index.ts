/**
 * Executor public interface. Every surface that changes a project goes
 * through these functions: apply a validated plan with journaled
 * checkpoints, resume an interrupted operation, preview/execute rollback,
 * and read operation state.
 *
 * Semantics (docs/v2-architecture.md#execution):
 * - Plans are validated against the plan contract (plus integrity: the
 *   fingerprint and every exact preview) and must target `root`.
 * - Policy: every required class must be allowed (or approved); external
 *   effects additionally need policy.external "ask" plus an explicit approval.
 * - A plan whose fingerprint already completed is a no-op (`alreadyApplied`).
 * - Preconditions are re-checked before any write; a changed affected path is
 *   GROOT_E_STALE_PLAN listing exactly those paths.
 * - One writer at a time (core/fs/lock.ts); intent is journaled before each
 *   step's effect and completion after it; SIGINT/abort stops at the next
 *   checkpoint (GROOT_E_INTERRUPTED, exit 130) and the operation is resumable.
 *
 * Layout: apply.ts · resume.ts · rollback.ts (+ rollback-exec.ts) · runner.ts
 * (checkpoint protocol) · steps*.ts (effects) · journal.ts · store.ts ·
 * freshness.ts · policy.ts · plans.ts · secrets.ts · fsops.ts · root.ts.
 */
import type { OperationState } from "../contracts/operation.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { checkPreconditions } from "./freshness.ts";
import { realRoot } from "./project.ts";
import * as store from "./store.ts";
import type { StaleFinding } from "./types.ts";

export { applyPlan } from "./apply.ts";
export { crashPoint } from "./crash.ts";
export { internalHandler, registerInternalHandler } from "./handlers.ts";
export {
  isPlanId,
  loadPlanFile,
  loadSavedPlan,
  savePlan,
  validatePlanDocument,
} from "./plans.ts";
export { deniedClasses, requiredClasses } from "./policy.ts";
export { resumeOperation } from "./resume.ts";
export { COMPENSATING_INSTALL, previewRollback, rollbackOperation } from "./rollback.ts";
export { findProjectRoot } from "./root.ts";
export { isHolderLive, isOperationId, type LockHolderInfo, readLockHolder } from "./store.ts";
export type {
  ApplyRequest,
  InternalHandler,
  InternalHandlerInput,
  ResumeOptions,
  StaleFinding,
} from "./types.ts";

/** Every operation in the project, newest first. */
export async function listOperations(root: string): Promise<OperationState[]> {
  return store.listOperations(realRoot(root));
}

/** One operation's state, rebuilt from its journal (GROOT_E_NOT_FOUND when unknown). */
export async function readOperation(root: string, operationId: string): Promise<OperationState> {
  return store.readOperation(realRoot(root), operationId);
}

/** Evaluate every precondition of `plan` against `root`; empty means fresh. */
export async function checkPlanFreshness(
  root: string,
  plan: OperationPlan,
): Promise<StaleFinding[]> {
  return checkPreconditions(realRoot(root), plan.preconditions);
}
