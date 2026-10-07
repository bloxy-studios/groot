/**
 * Executor public interface (agreed contract — implementation lands in this
 * directory). Every surface that changes a project goes through these
 * functions: apply a validated plan with journaled checkpoints, resume an
 * interrupted operation, preview/execute rollback, and read operation state.
 *
 * Semantics (docs/v2-architecture.md#execution):
 * - Plans are validated against the plan contract and must target `root`.
 * - Policy: every `requiredClasses` entry must be allowed (or approved).
 * - A plan whose fingerprint already completed is a no-op (`alreadyApplied`).
 * - Preconditions are re-checked before any write; a changed affected path is
 *   GROOT_E_STALE_PLAN listing exactly those paths.
 * - One writer at a time (core/fs/lock.ts); intent is journaled before each
 *   step's effect and completion after it; SIGINT/abort stops at the next
 *   checkpoint (GROOT_E_INTERRUPTED, exit 130) and the operation is resumable.
 */

import type { Policy } from "../contracts/blueprint.ts";
import type { ActionClass } from "../contracts/common.ts";
import type { OperationResult, OperationState, RollbackPreview } from "../contracts/operation.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import type { CoreContext } from "../runtime.ts";

export interface ApplyRequest {
  readonly plan: OperationPlan;
  /** Absolute project root the plan targets. */
  readonly root: string;
  readonly policy: Policy;
  /** Surface that initiated the operation ("apply", "adopt", "init", "context sync", …). */
  readonly command: string;
  /** Classes explicitly approved for this run beyond the policy (e.g. --allow external). */
  readonly approvals?: readonly ActionClass[];
}

export interface StaleFinding {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  readonly reason: string;
}

export interface InternalHandlerInput {
  readonly root: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ctx: CoreContext;
  readonly stepId: string;
}

/** A vetted engine stage wrapped as a journaled step (e.g. the v1 stitch). */
export type InternalHandler = (input: InternalHandlerInput) => Promise<{ created: string[] }>;

const notIntegrated = (what: string): never => {
  throw new GrootV2Error("GROOT_E_INTERNAL", `executor: ${what} is not integrated yet`);
};

export async function applyPlan(
  _ctx: CoreContext,
  _request: ApplyRequest,
): Promise<OperationResult> {
  return notIntegrated("applyPlan");
}

export async function resumeOperation(
  _ctx: CoreContext,
  _root: string,
  _operationId: string,
): Promise<OperationResult> {
  return notIntegrated("resumeOperation");
}

export async function previewRollback(
  _ctx: CoreContext,
  _root: string,
  _operationId: string,
): Promise<RollbackPreview> {
  return notIntegrated("previewRollback");
}

export async function rollbackOperation(
  _ctx: CoreContext,
  _root: string,
  _operationId: string,
): Promise<OperationResult> {
  return notIntegrated("rollbackOperation");
}

export async function listOperations(_root: string): Promise<OperationState[]> {
  return notIntegrated("listOperations");
}

export async function readOperation(_root: string, _operationId: string): Promise<OperationState> {
  return notIntegrated("readOperation");
}

export async function checkPlanFreshness(
  _root: string,
  _plan: OperationPlan,
): Promise<StaleFinding[]> {
  return notIntegrated("checkPlanFreshness");
}

/** Read + validate a plan document (untrusted input). */
export async function loadPlanFile(_path: string): Promise<OperationPlan> {
  return notIntegrated("loadPlanFile");
}

/** Persist a plan under .groot/plans/<planId>.json; returns the absolute path. */
export async function savePlan(_root: string, _plan: OperationPlan): Promise<string> {
  return notIntegrated("savePlan");
}

const internalHandlers = new Map<string, InternalHandler>();

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  internalHandlers.set(name, handler);
}

export function internalHandler(name: string): InternalHandler | undefined {
  return internalHandlers.get(name);
}
