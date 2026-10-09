/**
 * What each attempt sends the runner. The first attempt of a run resumes the
 * task's last live session when there is one (with the reason: requested
 * changes, failing checks, a failed or interrupted run) and otherwise starts
 * fresh with the full task prompt and the coordinator's project context.
 * Later attempts resume the session the previous attempt established, or —
 * when it established none, or its resume target turned out not to exist —
 * start fresh with the task prompt, the project context, AND the reason.
 */
import type { Task, TaskStatus } from "../contracts/task.ts";
import { toErrorInfo } from "../errors.ts";
import type { RunnerResult } from "../runners/types.ts";
import type { CoreContext } from "../runtime.ts";
import { type ContinueReason, continuePrompt, startPrompt } from "./prompt.ts";
import { lastSession } from "./recovery.ts";
import { type AcceptanceRecord, latestAcceptance, readReview } from "./store.ts";
import type { RunTaskOptions } from "./types.ts";

export interface AttemptPlan {
  readonly mode: "start" | "resume";
  readonly prompt: string;
  readonly resumeSessionId: string | null;
  /** Why the task continues (null for a first start) — kept for a fresh-start fallback. */
  readonly reason: ContinueReason | null;
}

/** The coordinator's project context, fetched at most once per run. */
export type ContextSource = (task: Task) => Promise<string | null>;

export function contextSource(
  ctx: CoreContext,
  root: string,
  options: RunTaskOptions,
): ContextSource {
  let cached: Promise<string | null> | null = null;
  return (task) => {
    cached ??= projectContext(ctx, root, task, options);
    return cached;
  };
}

async function projectContext(
  ctx: CoreContext,
  root: string,
  task: Task,
  options: RunTaskOptions,
): Promise<string | null> {
  if (options.contextProvider === undefined) return null;
  try {
    return await options.contextProvider(root, task);
  } catch (error) {
    ctx.events.emit({
      type: "task.warning",
      level: "warn",
      message: `${task.id}: project context unavailable (${toErrorInfo(error).message}); continuing without it`,
      taskId: task.id,
    });
    return null;
  }
}

async function continueReason(
  root: string,
  task: Task,
  priorStatus: TaskStatus,
): Promise<ContinueReason> {
  // A review sends a task back to `pending` with its notes; deliver them once.
  if (priorStatus === "pending" && task.review !== null) {
    const review = await readReview(root, task.review).catch(() => null);
    if (review?.verdict === "changes-requested") {
      return { kind: "changes-requested", notes: review.notes ?? "(no notes)" };
    }
  }
  const last = task.attempts.at(-1);
  const acceptance = await latestAcceptance(root, task);
  if (last?.status !== "interrupted") {
    const failures = (acceptance ?? []).filter((record) => record.status === "fail");
    if (failures.length > 0) return { kind: "retry", failures };
    if (last?.error) return { kind: "runner-failed", error: last.error.message };
  }
  return { kind: "resume", acceptance };
}

/** A fresh session that still carries why the task continues. */
export async function freshPlan(
  task: Task,
  context: ContextSource,
  reason: ContinueReason | null,
): Promise<AttemptPlan> {
  const start = startPrompt(task, await context(task));
  return {
    mode: "start",
    resumeSessionId: null,
    prompt: reason === null ? start : `${start}\n${continuePrompt(task, reason)}`,
    reason,
  };
}

export async function firstPlan(
  root: string,
  task: Task,
  context: ContextSource,
  priorStatus: TaskStatus,
): Promise<AttemptPlan> {
  const session = lastSession(task);
  if (session === null) {
    // A first start carries no reason; a restart after earlier attempts does.
    const reason =
      task.attempts.length === 0 ? null : await continueReason(root, task, priorStatus);
    return freshPlan(task, context, reason);
  }
  const reason = await continueReason(root, task, priorStatus);
  return {
    mode: "resume",
    resumeSessionId: session,
    prompt: continuePrompt(task, reason),
    reason,
  };
}

export async function retryPlan(
  task: Task,
  result: RunnerResult,
  acceptance: readonly AcceptanceRecord[],
  context: ContextSource,
): Promise<AttemptPlan> {
  const failures = acceptance.filter((record) => record.status === "fail");
  const reason: ContinueReason =
    failures.length > 0
      ? { kind: "retry", failures }
      : {
          kind: "runner-failed",
          error: result.error?.message ?? `the runner reported ${result.status}`,
        };
  // Only a session THIS attempt established is known to exist.
  if (result.sessionId === null) return freshPlan(task, context, reason);
  return {
    mode: "resume",
    resumeSessionId: result.sessionId,
    prompt: continuePrompt(task, reason),
    reason,
  };
}
