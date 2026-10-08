/**
 * Runner contract — how Groot drives an installed coding agent (Claude Code,
 * Codex) through its documented headless interface. An adapter discovers the
 * agent truthfully (executable, version, auth, features) and starts bounded
 * runs: prompt on stdin, explicit containment flags, a Groot-enforced wall
 * time, a redacted event log, and cancellation that sweeps the whole process
 * group. The outcome is classified from the agent's own terminal data — never
 * from its prose, and never from a `subtype: "success"` alone.
 */
import type { ErrorInfo } from "../contracts/envelope.ts";
import type { Attempt, RunnerCapabilities, RunnerId, UsageReport } from "../contracts/task.ts";

export type AttemptStatus = Attempt["status"];

/** Limits applied to one runner invocation. */
export interface RunnerLimits {
  readonly maxTurns: number;
  /** Spend cap where the runner enforces one (Claude Code); null otherwise. */
  readonly maxBudgetUsd: number | null;
  /** Groot-side wall clock for the whole invocation (startup included). */
  readonly wallTimeMs: number;
}

/** Escalation timings for cancellation (defaults: 10 s after SIGINT, 5 s after SIGTERM). */
export interface CancelGrace {
  readonly interruptMs: number;
  readonly terminateMs: number;
}

export interface RunnerInvocation {
  /** Working directory — the task's git worktree. */
  readonly cwd: string;
  /** Sent on stdin, never on argv (a stray positional would become a billable prompt). */
  readonly prompt: string;
  /** Pre-assigned session id (Claude `--session-id`); Codex assigns its own thread id. */
  readonly sessionId: string;
  /** Continue this provider session instead of starting a new one. */
  readonly resumeSessionId?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly limits: RunnerLimits;
  /**
   * Commands the agent may run. Claude Code: `Bash(<cmd>)` + `Bash(<cmd> *)`
   * allow rules — the only Bash commands it can run (sandboxed commands are
   * not auto-approved). Codex has no per-command rules: there they are
   * prompt guidance, and its workspace-write sandbox is the boundary.
   */
  readonly allowedCommands: readonly string[];
  /**
   * Absolute paths the agent's sandboxed commands must never write — the
   * repository's git directory, so no command can move the user's refs.
   * Claude Code: sandbox `filesystem.denyWrite`. Codex has no per-path
   * setting; the task layer still compares refs before and after every attempt.
   */
  readonly protectedPaths?: readonly string[];
  /** Absolute path of the redacted JSONL event log for this attempt. */
  readonly eventsLogPath: string;
  readonly signal: AbortSignal;
  /** Task rules appended to the agent's system prompt where supported. */
  readonly systemPrompt?: string | null;
  /** Base environment (CoreContext.env); scrubbed before it reaches the agent. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly grace?: CancelGrace;
  /**
   * Called once the runner process exists, with its pid — also its process
   * group id (runners lead their own group). Lets a caller record the group
   * so a later Groot can find a runner its crashed predecessor left behind.
   */
  readonly onSpawn?: (pid: number) => void;
}

/** A normalized view of one provider event (the raw line is in the attempt log). */
export interface RunnerEvent {
  readonly kind: "session" | "message" | "tool" | "notice" | "result" | "unknown";
  /** Provider event type, e.g. "system/init", "assistant", "item.completed". */
  readonly type: string;
  readonly at: string;
  /** One-line, redacted summary for progress output. */
  readonly summary: string;
}

export interface RunnerResult {
  readonly status: AttemptStatus;
  /** Provider session/thread id (resume handle), when one was established. */
  readonly sessionId: string | null;
  readonly exitCode: number | null;
  readonly usage: UsageReport;
  readonly finalMessage: string | null;
  readonly error: ErrorInfo | null;
  /** True when the event stream came from a simulated runner (tests, demos). */
  readonly simulated: boolean;
  /** Facts worth keeping with the attempt (runner version, model, wrapper skips, survivors). */
  readonly notes: readonly string[];
}

export interface RunnerHandle {
  readonly events: AsyncIterable<RunnerEvent>;
  readonly result: Promise<RunnerResult>;
  /** Interrupt → terminate → kill the process group; resolves once it is gone. */
  cancel(): Promise<void>;
}

/** Why a runner cannot take work right now — each cause has an exact next step. */
export type RunnerBlockCause =
  | "not-installed"
  | "incompatible"
  | "unauthenticated"
  | "config-incompatible"
  | "quota";

export interface RunnerBlock {
  readonly cause: RunnerBlockCause;
  readonly detail: string;
  readonly nextStep: string;
}

export interface RunnerPreflight {
  readonly capabilities: RunnerCapabilities;
  /** null when the runner can take work. */
  readonly block: RunnerBlock | null;
}

export interface RunnerAdapter {
  readonly id: RunnerId;
  discover(env?: Readonly<Record<string, string | undefined>>): Promise<RunnerCapabilities>;
  /** Discovery plus the precise reason the runner is unusable, if it is. */
  preflight(env?: Readonly<Record<string, string | undefined>>): Promise<RunnerPreflight>;
  start(invocation: RunnerInvocation): RunnerHandle;
}

export const DEFAULT_CANCEL_GRACE: CancelGrace = { interruptMs: 10_000, terminateMs: 5_000 };
