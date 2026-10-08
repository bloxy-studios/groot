/**
 * Public input/option shapes of the task API (core/tasks/index.ts). The
 * persisted document is the Task contract (core/contracts/task.ts).
 */
import type { VerificationProfile } from "../contracts/common.ts";
import type { RunnerId, Task, TaskLimits } from "../contracts/task.ts";
import type { CancelGrace } from "../runners/types.ts";

export interface CreateTaskInput {
  readonly objective: string;
  /** Defaults to the objective's first line (≤ 72 chars). */
  readonly title?: string | null;
  /** Defaults to claude-code. */
  readonly runner?: RunnerId;
  /** Provider model id or alias (aliases are provider-dependent). */
  readonly model?: string | null;
  readonly dependsOn?: readonly string[];
  /** Project-relative globs the task may change; defaults to ["**"]. */
  readonly ownership?: readonly string[];
  /** Acceptance commands, split into argv WITHOUT a shell ("bun test"). */
  readonly accept?: readonly string[];
  /** Acceptance by Groot verification profile (needs a v2 groot.json). */
  readonly acceptVerify?: readonly VerificationProfile[];
  readonly limits?: Partial<TaskLimits>;
  /** Timeout per acceptance criterion (default 600 s). */
  readonly acceptTimeoutSec?: number;
}

export interface RunTaskOptions {
  /** Task-scoped project context for the prompt (the coordinator wires `groot context --task`). */
  readonly contextProvider?: (root: string, task: Task) => Promise<string>;
  /** Reasoning effort for this run (Claude: low|medium|high|xhigh|max). Not persisted. */
  readonly effort?: string | null;
  /** Cancellation escalation timings (defaults: 10 s after SIGINT, 5 s after SIGTERM). */
  readonly grace?: CancelGrace;
}

export interface ReviewDecision {
  readonly approve?: boolean;
  readonly requestChanges?: string;
}

export const DEFAULT_WALL_TIME_SEC = 900;
export const DEFAULT_MAX_TURNS = 25;
/** Claude Code enforces a spend cap; Codex has none (reported, not enforced). */
export const DEFAULT_CLAUDE_BUDGET_USD = 2;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_ACCEPT_TIMEOUT_SEC = 600;
export const MAX_PARALLEL = 4;
export const DEFAULT_PARALLEL = 2;
