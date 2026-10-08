/**
 * Public executor types (re-exported by core/executor/index.ts). Kept in their
 * own module so the implementation files can share them without importing the
 * public entry point.
 */
import type { Policy } from "../contracts/blueprint.ts";
import type { ActionClass } from "../contracts/common.ts";
import type { OperationPlan } from "../contracts/plan.ts";
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

export interface ResumeOptions {
  /** Re-run this interrupted step even though it is not provably safe to repeat. */
  readonly retryStep?: string;
  /** Mark this interrupted step done without running it (a human vouches for its effect). */
  readonly skipStep?: string;
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
