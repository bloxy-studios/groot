/**
 * The core API the MCP server drives — the same functions and policy the CLI
 * uses, behind one interface so the protocol layer never reparses
 * presentation text or re-implements rules. `core/api.ts` provides the real
 * implementation; tests inject fakes.
 */
import type { SolverRefusal } from "../contracts/capability.ts";
import type { ActionClass, VerificationProfile } from "../contracts/common.ts";
import type { SyncFileChange, TaskContext } from "../contracts/context.ts";
import type { Evidence, VerificationReport } from "../contracts/evidence.ts";
import type { OperationResult, OperationState, RollbackPreview } from "../contracts/operation.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import type { Review, Task } from "../contracts/task.ts";
import type { CoreContext } from "../runtime.ts";

export interface CapabilityRequestInput {
  readonly capability: string;
  readonly recipe?: string | null;
  readonly target?: string | null;
}

export interface DescribeResult {
  readonly grootVersion: string;
  readonly contracts: readonly { name: string; title: string; url: string }[];
  readonly capabilities: readonly { id: string; title: string; recipes: readonly string[] }[];
  readonly errorIds: readonly { id: string; exitCode: number }[];
}

export interface ContextSyncPlan {
  readonly plan: OperationPlan;
  readonly changes: readonly SyncFileChange[];
  readonly warnings: readonly string[];
}

export interface CreateTaskRequest {
  readonly objective: string;
  readonly title?: string;
  readonly runner: "claude-code" | "codex";
  readonly model?: string | null;
  readonly dependsOn?: readonly string[];
  readonly ownership?: readonly string[];
  readonly accept?: readonly string[];
  readonly acceptVerify?: readonly VerificationProfile[];
}

export interface GrootApi {
  describe(): Promise<DescribeResult>;
  /** Resolve the project root containing `dir` (groot.json or .groot/), or `dir` itself. */
  projectRoot(dir: string): string;
  inspect(ctx: CoreContext, root: string): Promise<ProjectObservation>;
  context(ctx: CoreContext, root: string, task: string | null): Promise<TaskContext>;
  /** Plan capabilities and persist the plan (refusals throw GROOT_E_* with alternatives). */
  planAdd(
    ctx: CoreContext,
    root: string,
    requests: readonly CapabilityRequestInput[],
    options: { experimental: boolean },
  ): Promise<OperationPlan>;
  planContextSync(ctx: CoreContext, root: string, skipConflicts: boolean): Promise<ContextSyncPlan>;
  getPlan(root: string, planId: string): Promise<OperationPlan>;
  apply(
    ctx: CoreContext,
    root: string,
    plan: OperationPlan,
    approvals: readonly ActionClass[],
  ): Promise<OperationResult>;
  resume(
    ctx: CoreContext,
    root: string,
    operationId: string,
    options: {
      retryStep?: string;
      skipStep?: string;
      /** Classes approved for this run (resume re-checks the policy; apply's approvals do not carry over). */
      approvals?: readonly ActionClass[];
    },
  ): Promise<OperationResult>;
  previewRollback(ctx: CoreContext, root: string, operationId: string): Promise<RollbackPreview>;
  rollback(ctx: CoreContext, root: string, operationId: string): Promise<OperationResult>;
  listOperations(root: string): Promise<OperationState[]>;
  readOperation(root: string, operationId: string): Promise<OperationState>;
  verify(
    ctx: CoreContext,
    root: string,
    options: { profiles: readonly VerificationProfile[]; capability: string | null },
  ): Promise<VerificationReport>;
  getEvidence(root: string, id: string): Promise<Evidence>;
  createTask(ctx: CoreContext, root: string, request: CreateTaskRequest): Promise<Task>;
  listTasks(root: string): Promise<Task[]>;
  readTask(root: string, id: string): Promise<Task>;
  runTask(ctx: CoreContext, root: string, id: string): Promise<Task>;
  reviewTask(
    ctx: CoreContext,
    root: string,
    id: string,
    decision: { approve?: boolean; requestChanges?: string },
  ): Promise<Review>;
  integrateTask(ctx: CoreContext, root: string, id: string): Promise<Task>;
}

export type { SolverRefusal };
