/**
 * Running a task (docs/v2-architecture.md#agent-runners-and-tasks):
 *
 * 1. Gate: dependencies must be `completed`, and the runner must be usable
 *    (installed, compatible, authenticated, config loadable) — otherwise the
 *    task is `blocked` with the exact cause and next step.
 * 2. Claim, under the project lock: re-read the task and check it is still
 *    runnable (another process may have run it meanwhile), refuse ownership
 *    that overlaps a RUNNING task (blocked — runs serialize), create the
 *    worktree `.groot/worktrees/<id>` on `groot/task/<id>` from the base
 *    commit, and mark the task running (with a pid marker so a crashed run
 *    is detected — recovery.ts).
 * 3. Attempts (≤ limits.maxAttempts): run the agent; an attempt that moved
 *    git refs outside Groot's branches blocks the task; Groot commits the
 *    worktree itself; Groot runs the acceptance checks (evidence; before
 *    review the agent's code runs without credentials). All pass →
 *    `awaiting-review`. A failing check is fed back by resuming the SAME
 *    session when possible (plans.ts); a resume target the runner does not
 *    know is replaced by a fresh session without spending an attempt; out of
 *    attempts → `failed`.
 *
 * Abort (SIGINT, MCP cancel) cancels the runner, records the attempt and the
 * task as `interrupted` (the session id is kept), and releases everything;
 * `resumeTask` continues that session. Completion is never decided by the
 * agent's own message.
 */
import type { Task, TaskStatus } from "../contracts/task.ts";
import { GrootV2Error, toErrorInfo } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { redact } from "../redact.ts";
import { RUNNER_LABEL } from "../runners/common.ts";
import { assertEffort, getRunner, knownSecretsFromEnv } from "../runners/index.ts";
import type { RunnerBlock, RunnerResult } from "../runners/types.ts";
import type { CoreContext } from "../runtime.ts";
import { runAcceptance } from "./acceptance.ts";
import { type AttemptOutcome, runAttempt } from "./attempt.ts";
import { commitAll, ensureWorktree, repositoryRoot } from "./git-ops.ts";
import { withProjectLock } from "./lock.ts";
import { ownershipOverlap } from "./ownership.ts";
import { type ContextSource, contextSource, firstPlan, freshPlan, retryPlan } from "./plans.ts";
import { isSessionNotFound, lastSession, reconcile } from "./recovery.ts";
import {
  type AcceptanceRecord,
  clearMarker,
  listTasks,
  readTask,
  taskBranch,
  taskPaths,
  touch,
  writeAcceptance,
  writeMarker,
  writeTask,
} from "./store.ts";
import type { RunTaskOptions } from "./types.ts";

export { lastSession, reconcile } from "./recovery.ts";

const RUNNABLE: readonly TaskStatus[] = ["pending", "failed", "interrupted", "blocked"];
/** Runner outcomes after which another attempt can help (others end the run). */
const RETRYABLE: ReadonlySet<string> = new Set(["succeeded", "failed"]);
/** Ref changes listed in a blocked reason (the rest are counted). */
const REF_CHANGES_SHOWN = 5;

const LEVEL: Record<TaskStatus, "info" | "warn" | "error"> = {
  pending: "info",
  running: "info",
  "awaiting-review": "info",
  completed: "info",
  blocked: "warn",
  interrupted: "warn",
  failed: "error",
};

/** What one run carries across its attempts. */
interface RunScope {
  readonly ctx: CoreContext;
  readonly root: string;
  readonly options: RunTaskOptions;
  /** Env-derived secret values, computed once per run and redacted from everything stored. */
  readonly secrets: readonly string[];
  readonly context: ContextSource;
}

/** Blocked after review (integration problems) — rerunning the agent won't help. */
export function blockedAfterReview(task: Task): boolean {
  return task.status === "blocked" && task.integration !== null;
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

function stateError(task: Task, action: string): GrootV2Error {
  const next: Partial<Record<TaskStatus, string>> = {
    running: task.statusReason ?? "It is already running.",
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

function assertRunnable(task: Task, action: string): void {
  if (!RUNNABLE.includes(task.status) || blockedAfterReview(task)) throw stateError(task, action);
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

/** Why the task cannot start at all (unmet dependencies, unusable runner), or null. */
async function gateBlock(ctx: CoreContext, root: string, task: Task): Promise<string | null> {
  const waiting = await dependencyBlock(root, task);
  if (waiting !== null) return waiting;
  const preflight = await getRunner(task.runner).preflight(ctx.env);
  return preflight.block === null ? null : describeBlock(task, preflight.block);
}

/** A running task whose ownership overlaps this one's (runs serialize), or null. */
async function overlappingRun(root: string, task: Task): Promise<string | null> {
  const others = await Promise.all(
    (await listTasks(root))
      .filter((entry) => entry.id !== task.id)
      .map((entry) => reconcile(root, entry)),
  );
  for (const other of others.filter((entry) => entry.status === "running")) {
    const pair = ownershipOverlap(task.ownership, other.ownership);
    if (pair !== null) {
      return `ownership overlaps running task ${other.id} (${pair[0]} ~ ${pair[1]}); run it again once that task finishes`;
    }
  }
  return null;
}

/** Under the project lock: re-validation, gate, overlap check, worktree, status running. */
async function claim(
  ctx: CoreContext,
  root: string,
  id: string,
  action: string,
  gate: string | null,
): Promise<Task> {
  // Another process may have run (or finished) the task since the caller read it.
  const task = await reconcile(root, await readTask(root, id));
  assertRunnable(task, action);
  const blocked = gate ?? (await overlappingRun(root, task));
  if (blocked !== null) return finish(ctx, root, task, "blocked", blocked);
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

function refsMovedReason(changes: readonly string[]): string {
  const shown = changes.slice(0, REF_CHANGES_SHOWN).join("; ");
  const more =
    changes.length > REF_CHANGES_SHOWN ? `; ${changes.length - REF_CHANGES_SHOWN} more` : "";
  return redact(
    `git refs outside the task branch changed while the agent ran (${shown}${more}) — groot cannot tell an agent's change from yours or another tool's: check \`git reflog\` for each, restore what should not have moved, then run the task again`,
  );
}

/** The run ends right after the runner returned: refs moved, an interruption, an unusable runner. */
function afterRunner(scope: RunScope, task: Task, outcome: AttemptOutcome): Task | null {
  const { ctx, root } = scope;
  if (outcome.refChanges.length > 0) {
    return finish(ctx, root, task, "blocked", refsMovedReason(outcome.refChanges));
  }
  if (outcome.result.status === "interrupted" || ctx.signal.aborted) {
    return finishInterrupted(ctx, root, task);
  }
  if (isBlocking(outcome.result)) {
    const reason = outcome.result.error?.message ?? "the runner is unavailable";
    return finish(ctx, root, task, "blocked", reason);
  }
  return null;
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

/** Commit what the runner left, then check it (pre-review: credential-free) and store the results. */
async function checkAttempt(
  scope: RunScope,
  task: Task,
  result: RunnerResult,
): Promise<{ task: Task; acceptance: AcceptanceRecord[] }> {
  const { ctx, root } = scope;
  await commitAttempt(ctx, root, task);
  const acceptance = await runAcceptance(ctx, {
    root,
    cwd: task.worktree?.path ?? root,
    task,
    simulated: result.simulated,
    reviewed: false,
    secrets: scope.secrets,
  });
  writeAcceptance(root, task.id, task.attempts.length, acceptance);
  const evidence = [...task.evidence, ...acceptance.flatMap((record) => record.evidence)];
  return { task: writeTask(root, touch(task, { evidence })), acceptance };
}

async function attemptLoop(scope: RunScope, claimed: Task, priorStatus: TaskStatus): Promise<Task> {
  const { ctx, root } = scope;
  let task = claimed;
  let plan = await firstPlan(root, task, scope.context, priorStatus);
  for (let used = 1; ; used++) {
    const outcome = await runAttempt(ctx, root, task, plan, scope.options);
    task = outcome.task;
    const stopped = afterRunner(scope, task, outcome);
    if (stopped !== null) return stopped;
    if (plan.mode === "resume" && isSessionNotFound(outcome.result)) {
      // The runner never reached the model: a fresh session costs no attempt.
      plan = await freshPlan(task, scope.context, plan.reason);
      used--;
      continue;
    }
    const checked = await checkAttempt(scope, task, outcome.result);
    task = checked.task;
    if (ctx.signal.aborted) {
      return finishInterrupted(ctx, root, task, " during the acceptance checks");
    }
    const verdict = judge(outcome.result, checked.acceptance);
    if (verdict.status !== "retry") return finish(ctx, root, task, verdict.status, verdict.reason);
    if (used >= task.limits.maxAttempts) {
      const reason = `${verdict.reason ?? "not accepted"} (attempt ${used} of ${task.limits.maxAttempts})`;
      return finish(ctx, root, task, "failed", reason);
    }
    plan = await retryPlan(task, outcome.result, checked.acceptance, scope.context);
  }
}

async function execute(
  ctx: CoreContext,
  root: string,
  task: Task,
  options: RunTaskOptions,
  action: "run" | "resume",
): Promise<Task> {
  const gate = await gateBlock(ctx, root, task);
  const claimed = await withProjectLock(root, `task ${action}`, () =>
    claim(ctx, root, task.id, action, gate),
  );
  if (claimed.status !== "running") return claimed;
  const scope: RunScope = {
    ctx,
    root,
    options,
    secrets: knownSecretsFromEnv(ctx.env),
    context: contextSource(ctx, root, options),
  };
  try {
    return await attemptLoop(scope, claimed, task.status);
  } catch (error) {
    const current = await readTask(root, task.id).catch(() => claimed);
    if (ctx.signal.aborted) return finishInterrupted(ctx, root, current);
    return finish(
      ctx,
      root,
      current,
      "failed",
      `groot could not finish the run: ${redact(toErrorInfo(error).message, scope.secrets)}`,
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
  assertRunnable(task, "run");
  if (options.effort) assertEffort(task.runner, options.effort);
  return execute(ctx, repo, task, options, "run");
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
  assertRunnable(task, "resume");
  if (lastSession(task) === null) {
    throw new GrootV2Error("GROOT_E_NOT_RESUMABLE", `Task ${id} has no runner session to resume.`, {
      hint: `Start it with \`groot task run ${id}\`.`,
    });
  }
  if (options.effort) assertEffort(task.runner, options.effort);
  return execute(ctx, repo, task, options, "resume");
}
