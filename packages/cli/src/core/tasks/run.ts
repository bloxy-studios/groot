/**
 * Running a task (docs/v2-architecture.md#agent-runners-and-tasks):
 *
 * 1. Gate: dependencies must be `completed`, and the runner must be usable
 *    (installed, compatible, authenticated, config loadable) — otherwise the
 *    task is `blocked` with the exact cause and next step.
 * 2. Claim, under the project lock: refuse ownership that overlaps a RUNNING
 *    task (blocked — runs serialize), create the worktree
 *    `.groot/worktrees/<id>` on `groot/task/<id>` from the base commit, and
 *    mark the task running (with a pid marker so a crashed run is detected).
 * 3. Attempts (≤ limits.maxAttempts): run the agent; Groot commits the
 *    worktree itself; Groot runs the acceptance checks (evidence). All pass →
 *    `awaiting-review`. A failing check is fed back by resuming the SAME
 *    session when possible; out of attempts → `failed`.
 *
 * Abort (SIGINT, MCP cancel) cancels the runner, records the attempt and the
 * task as `interrupted` (the session id is kept), and releases everything;
 * `resumeTask` continues that session. Completion is never decided by the
 * agent's own message.
 */
import type { Task, TaskStatus } from "../contracts/task.ts";
import { GrootV2Error, toErrorInfo } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { RUNNER_LABEL } from "../runners/common.ts";
import { getRunner } from "../runners/index.ts";
import type { RunnerBlock, RunnerResult } from "../runners/types.ts";
import type { CoreContext } from "../runtime.ts";
import { runAcceptance } from "./acceptance.ts";
import { type AttemptPlan, runAttempt } from "./attempt.ts";
import { commitAll, ensureWorktree, repositoryRoot } from "./git-ops.ts";
import { withProjectLock } from "./lock.ts";
import { ownershipOverlap } from "./ownership.ts";
import { type ContinueReason, continuePrompt, startPrompt } from "./prompt.ts";
import {
  type AcceptanceRecord,
  clearMarker,
  isLiveRun,
  latestAcceptance,
  listTasks,
  readReview,
  readTask,
  taskBranch,
  taskPaths,
  touch,
  writeAcceptance,
  writeMarker,
  writeTask,
} from "./store.ts";
import type { RunTaskOptions } from "./types.ts";

const RUNNABLE: readonly TaskStatus[] = ["pending", "failed", "interrupted", "blocked"];
/** Runner outcomes after which another attempt can help (others end the run). */
const RETRYABLE: ReadonlySet<string> = new Set(["succeeded", "failed"]);

const LEVEL: Record<TaskStatus, "info" | "warn" | "error"> = {
  pending: "info",
  running: "info",
  "awaiting-review": "info",
  completed: "info",
  blocked: "warn",
  interrupted: "warn",
  failed: "error",
};

/** Blocked after review (integration problems) — rerunning the agent won't help. */
export function blockedAfterReview(task: Task): boolean {
  return task.status === "blocked" && task.integration !== null;
}

/** The most recent provider session the task established (resume handle). */
export function lastSession(task: Task): string | null {
  for (const attempt of [...task.attempts].reverse()) {
    if (attempt.sessionId !== null) return attempt.sessionId;
  }
  return null;
}

/** Persist a terminal (or waiting) state; closes any attempt still marked running. */
export function finish(
  ctx: CoreContext,
  root: string,
  task: Task,
  status: TaskStatus,
  reason: string | null,
): Task {
  clearMarker(root, task.id);
  const attempts = task.attempts.map((attempt) =>
    attempt.status === "running"
      ? {
          ...attempt,
          status: status === "interrupted" ? ("interrupted" as const) : ("failed" as const),
          finishedAt: nowIso(),
        }
      : attempt,
  );
  const done = writeTask(root, touch(task, { status, statusReason: reason, attempts }));
  ctx.events.emit({
    type: `task.${status}`,
    level: LEVEL[status],
    message: `${task.id} ${status}${reason === null ? "" : ` — ${reason}`}`,
    taskId: task.id,
  });
  return done;
}

function finishInterrupted(ctx: CoreContext, root: string, task: Task, when = ""): Task {
  const reason =
    lastSession(task) === null
      ? `interrupted${when} before the runner established a session — start it again with \`groot task run ${task.id}\``
      : `interrupted${when} — continue with \`groot task resume ${task.id}\``;
  return finish(ctx, root, task, "interrupted", reason);
}

/**
 * A task recorded as running whose process is gone (crash, kill -9) becomes
 * interrupted, so it can be resumed and stops blocking overlapping work.
 */
export async function reconcile(root: string, task: Task): Promise<Task> {
  if (task.status !== "running" || (await isLiveRun(root, task.id))) return task;
  clearMarker(root, task.id);
  const attempts = task.attempts.map((attempt) =>
    attempt.status === "running"
      ? { ...attempt, status: "interrupted" as const, finishedAt: nowIso() }
      : attempt,
  );
  return writeTask(
    root,
    touch(task, {
      status: "interrupted",
      statusReason: `the groot process running it exited unexpectedly — continue with \`groot task resume ${task.id}\``,
      attempts,
    }),
  );
}

function stateError(task: Task, action: string): GrootV2Error {
  const next: Partial<Record<TaskStatus, string>> = {
    running: "It is already running.",
    "awaiting-review": `Review it with \`groot review ${task.id}\`.`,
    completed: "It is already integrated.",
    blocked: `It is blocked after review: ${task.statusReason ?? "see groot task show"}.`,
  };
  return new GrootV2Error(
    "GROOT_E_TASK_STATE",
    `Cannot ${action} task ${task.id} (status: ${task.status}).`,
    {
      hint: next[task.status] ?? `See \`groot task show ${task.id}\`.`,
      details: { status: task.status },
    },
  );
}

async function dependencyBlock(root: string, task: Task): Promise<string | null> {
  if (task.dependsOn.length === 0) return null;
  const byId = new Map((await listTasks(root)).map((entry) => [entry.id, entry]));
  const unmet = task.dependsOn.filter((id) => byId.get(id)?.status !== "completed");
  if (unmet.length === 0) return null;
  const list = unmet.map((id) => `${id} (${byId.get(id)?.status ?? "missing"})`).join(", ");
  return `waiting on ${list} — dependencies must be completed (reviewed and integrated) first`;
}

function describeBlock(task: Task, block: RunnerBlock): string {
  return `${RUNNER_LABEL[task.runner]} is blocked (${block.cause}): ${block.detail}. Next step: ${block.nextStep}`;
}

/** Under the project lock: overlap check, worktree, status running. */
async function claim(ctx: CoreContext, root: string, id: string): Promise<Task> {
  const task = await reconcile(root, await readTask(root, id));
  if (task.status === "running") throw stateError(task, "run");
  const others = await Promise.all(
    (await listTasks(root))
      .filter((entry) => entry.id !== id)
      .map((entry) => reconcile(root, entry)),
  );
  for (const other of others.filter((entry) => entry.status === "running")) {
    const pair = ownershipOverlap(task.ownership, other.ownership);
    if (pair !== null) {
      return finish(
        ctx,
        root,
        task,
        "blocked",
        `ownership overlaps running task ${other.id} (${pair[0]} ~ ${pair[1]}); run it again once that task finishes`,
      );
    }
  }
  const path = await ensureWorktree(
    root,
    taskPaths.worktree(root, id),
    taskBranch(id),
    task.base.commit,
    ctx.env,
  );
  writeMarker(root, id);
  const running = writeTask(
    root,
    touch(task, {
      status: "running",
      statusReason: null,
      worktree: { path, branch: taskBranch(id) },
    }),
  );
  ctx.events.emit({
    type: "task.running",
    level: "info",
    message: `${id} running in ${path} (branch ${taskBranch(id)})`,
    taskId: id,
  });
  return running;
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

async function firstPlan(
  ctx: CoreContext,
  root: string,
  task: Task,
  options: RunTaskOptions,
  priorStatus: TaskStatus,
): Promise<AttemptPlan> {
  const session = lastSession(task);
  if (session !== null) {
    return {
      mode: "resume",
      resumeSessionId: session,
      prompt: continuePrompt(task, await continueReason(root, task, priorStatus)),
    };
  }
  return {
    mode: "start",
    resumeSessionId: null,
    prompt: startPrompt(task, await projectContext(ctx, root, task, options)),
  };
}

function retryPlan(
  task: Task,
  result: RunnerResult,
  acceptance: readonly AcceptanceRecord[],
): AttemptPlan {
  const failures = acceptance.filter((record) => record.status === "fail");
  const reason: ContinueReason =
    failures.length > 0
      ? { kind: "retry", failures }
      : {
          kind: "runner-failed",
          error: result.error?.message ?? `the runner reported ${result.status}`,
        };
  // Only a session THIS attempt established is known to exist.
  if (result.sessionId !== null) {
    return {
      mode: "resume",
      resumeSessionId: result.sessionId,
      prompt: continuePrompt(task, reason),
    };
  }
  return {
    mode: "start",
    resumeSessionId: null,
    prompt: `${startPrompt(task, null)}\n${continuePrompt(task, reason)}`,
  };
}

interface Verdict {
  readonly status: "awaiting-review" | "blocked" | "failed" | "retry";
  readonly reason: string | null;
}

/** Decide from acceptance evidence first, the runner's own outcome second. */
export function judge(result: RunnerResult, acceptance: readonly AcceptanceRecord[]): Verdict {
  const runnerNote =
    result.status === "succeeded"
      ? null
      : `the runner reported ${result.status}${result.error === null ? "" : ` (${result.error.message})`}`;
  const list = (records: readonly AcceptanceRecord[]) =>
    records.map((record) => `${record.criterion}: ${record.summary}`).join("; ");
  const failed = acceptance.filter((record) => record.status === "fail");
  if (failed.length > 0) {
    const reason = `acceptance failed — ${list(failed)}`;
    return RETRYABLE.has(result.status)
      ? { status: "retry", reason }
      : { status: "failed", reason: `${reason}; ${runnerNote}` };
  }
  const unproven = acceptance.filter((record) => record.status !== "pass");
  if (unproven.length > 0) {
    return { status: "blocked", reason: `acceptance could not be established — ${list(unproven)}` };
  }
  if (acceptance.length > 0) {
    return {
      status: "awaiting-review",
      reason: runnerNote === null ? null : `acceptance passed although ${runnerNote}`,
    };
  }
  if (result.status === "succeeded") {
    return {
      status: "awaiting-review",
      reason: "no acceptance criteria — the change rests on review",
    };
  }
  return RETRYABLE.has(result.status)
    ? { status: "retry", reason: runnerNote }
    : { status: "failed", reason: runnerNote };
}

function isBlocking(result: RunnerResult): boolean {
  return (
    result.error?.id === "GROOT_E_BLOCKED" || result.error?.id === "GROOT_E_RUNNER_UNAVAILABLE"
  );
}

async function commitAttempt(ctx: CoreContext, root: string, task: Task): Promise<void> {
  const n = task.attempts.length;
  const outcome = await commitAll(
    task.worktree?.path ?? root,
    `groot: ${task.title}\n\nTask ${task.id}, attempt ${n} (${task.runner}).`,
    ctx.env,
  );
  ctx.events.emit({
    type: "task.committed",
    level: "info",
    message: outcome.committed
      ? `${task.id}: committed the runner's changes as ${outcome.head.slice(0, 12)}`
      : `${task.id}: the runner left no changes to commit`,
    taskId: task.id,
    data: { committed: outcome.committed, head: outcome.head },
  });
}

async function attemptLoop(
  ctx: CoreContext,
  root: string,
  claimed: Task,
  options: RunTaskOptions,
  priorStatus: TaskStatus,
): Promise<Task> {
  let task = claimed;
  let plan = await firstPlan(ctx, root, task, options, priorStatus);
  for (let used = 1; ; used++) {
    const outcome = await runAttempt(ctx, root, task, plan, options);
    task = outcome.task;
    const { result } = outcome;
    if (result.status === "interrupted" || ctx.signal.aborted)
      return finishInterrupted(ctx, root, task);
    if (isBlocking(result)) {
      return finish(
        ctx,
        root,
        task,
        "blocked",
        result.error?.message ?? "the runner is unavailable",
      );
    }
    await commitAttempt(ctx, root, task);
    const acceptance = await runAcceptance(ctx, {
      root,
      cwd: task.worktree?.path ?? root,
      task,
      simulated: result.simulated,
    });
    writeAcceptance(root, task.id, task.attempts.length, acceptance);
    task = writeTask(
      root,
      touch(task, {
        evidence: [...task.evidence, ...acceptance.flatMap((record) => record.evidence)],
      }),
    );
    if (ctx.signal.aborted)
      return finishInterrupted(ctx, root, task, " during the acceptance checks");
    const verdict = judge(result, acceptance);
    if (verdict.status !== "retry") return finish(ctx, root, task, verdict.status, verdict.reason);
    if (used >= task.limits.maxAttempts) {
      return finish(
        ctx,
        root,
        task,
        "failed",
        `${verdict.reason ?? "not accepted"} (attempt ${used} of ${task.limits.maxAttempts})`,
      );
    }
    plan = retryPlan(task, result, acceptance);
  }
}

async function execute(
  ctx: CoreContext,
  root: string,
  task: Task,
  options: RunTaskOptions,
): Promise<Task> {
  const waiting = await dependencyBlock(root, task);
  if (waiting !== null) return finish(ctx, root, task, "blocked", waiting);
  const preflight = await getRunner(task.runner).preflight(ctx.env);
  if (preflight.block !== null)
    return finish(ctx, root, task, "blocked", describeBlock(task, preflight.block));
  const claimed = await withProjectLock(root, "task run", () => claim(ctx, root, task.id));
  if (claimed.status !== "running") return claimed;
  try {
    return await attemptLoop(ctx, root, claimed, options, task.status);
  } catch (error) {
    const current = await readTask(root, task.id).catch(() => claimed);
    if (ctx.signal.aborted) return finishInterrupted(ctx, root, current);
    return finish(
      ctx,
      root,
      current,
      "failed",
      `groot could not finish the run: ${toErrorInfo(error).message}`,
    );
  }
}

/** Run a task (pending, failed, interrupted, or blocked before review). */
export async function runTask(
  ctx: CoreContext,
  root: string,
  id: string,
  options: RunTaskOptions = {},
): Promise<Task> {
  const repo = await repositoryRoot(root, ctx.env);
  const task = await reconcile(repo, await readTask(repo, id));
  if (!RUNNABLE.includes(task.status) || blockedAfterReview(task)) throw stateError(task, "run");
  return execute(ctx, repo, task, options);
}

/** Continue a task's runner session (after an interruption, failure, or requested changes). */
export async function resumeTask(
  ctx: CoreContext,
  root: string,
  id: string,
  options: RunTaskOptions = {},
): Promise<Task> {
  const repo = await repositoryRoot(root, ctx.env);
  const task = await reconcile(repo, await readTask(repo, id));
  if (!RUNNABLE.includes(task.status) || blockedAfterReview(task)) throw stateError(task, "resume");
  if (lastSession(task) === null) {
    throw new GrootV2Error("GROOT_E_NOT_RESUMABLE", `Task ${id} has no runner session to resume.`, {
      hint: `Start it with \`groot task run ${id}\`.`,
    });
  }
  return execute(ctx, repo, task, options);
}
