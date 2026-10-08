/**
 * Recovery of runs a Groot process left behind. A task recorded as
 * `running` whose Groot process is gone (crash, kill -9, closed terminal) is
 * reconciled before anything runs it again:
 *
 * - a runner the dead process recorded (runner.json: process group + spawn
 *   time) that is provably still that runner is stopped first — otherwise it
 *   keeps editing the worktree, with no wall time, beside the next run;
 * - a group that is alive but cannot be confirmed as that runner (its leader
 *   has exited) is never signalled: the task stays `running`, with the exact
 *   next step in its reason;
 * - a crashed attempt keeps its session id only when its log shows the
 *   session was established — a pre-assigned id the runner never created
 *   cannot be resumed;
 * - then the task becomes `interrupted`.
 *
 * `viewTask` answers the same question without changing anything (task
 * show/list, MCP reads), and `lastSession` skips sessions a resume found
 * missing.
 */
import { readFile } from "node:fs/promises";
import type { Attempt, Task } from "../contracts/task.ts";
import { nowIso } from "../ids.ts";
import { inspectRunnerGroup, logShowsSession, stopRunnerGroup } from "../runners/index.ts";
import {
  clearMarker,
  isLiveMarker,
  listTasks,
  type RunMarker,
  readMarker,
  readTask,
  taskPaths,
  touch,
  writeTask,
} from "./store.ts";

/** ErrorInfo.details.cause of a resume whose target the runner does not know. */
export const SESSION_NOT_FOUND = "session-not-found";

/** Did this runner result (or attempt) fail because its resume target does not exist? */
export function isSessionNotFound(entry: { readonly error: Attempt["error"] }): boolean {
  return entry.error?.details?.cause === SESSION_NOT_FOUND;
}

/** The most recent provider session the task established (resume handle), skipping dead ones. */
export function lastSession(task: Task): string | null {
  const dead = new Set(
    task.attempts.filter(isSessionNotFound).map((attempt) => attempt.resumedFrom),
  );
  for (const attempt of [...task.attempts].reverse()) {
    if (attempt.sessionId !== null && !dead.has(attempt.sessionId)) return attempt.sessionId;
  }
  return null;
}

type Leftover =
  | { readonly kind: "none" }
  | { readonly kind: "stopped"; readonly pgid: number }
  | { readonly kind: "alive"; readonly pgid: number; readonly verified: boolean }
  | { readonly kind: "survived"; readonly pgid: number };

/** The recorded runner group of a dead Groot process: gone, stopped (when `stop`), or alive. */
async function leftoverRunner(marker: RunMarker | null, stop: boolean): Promise<Leftover> {
  const runner = marker?.runner;
  if (runner === undefined) return { kind: "none" };
  const found = await inspectRunnerGroup(runner);
  if (found === "gone") return { kind: "none" };
  if (found === "unverified" || !stop) {
    return { kind: "alive", pgid: runner.pgid, verified: found === "runner" };
  }
  return (await stopRunnerGroup(runner.pgid))
    ? { kind: "stopped", pgid: runner.pgid }
    : { kind: "survived", pgid: runner.pgid };
}

function runningReason(task: Task, leftover: Leftover): string {
  const dead = "the groot process running it exited unexpectedly";
  if (leftover.kind === "survived") {
    return `${dead}, and its runner (process group ${leftover.pgid}) could not be stopped: stop it (\`kill -KILL -${leftover.pgid}\`), then run the task again`;
  }
  if (leftover.kind === "alive" && leftover.verified) {
    return `${dead}, but its runner is still running unsupervised (process group ${leftover.pgid}) — \`groot task resume ${task.id}\` or \`groot task run ${task.id}\` stops it first`;
  }
  const pgid = leftover.kind === "none" ? "?" : leftover.pgid;
  return `${dead}, and process group ${pgid} of its runner is still alive, but groot cannot confirm it is that runner (its leader exited): check it (\`pgrep -lg ${pgid}\`), stop it (\`kill -TERM -${pgid}\`) if it is the task's — or delete ${taskPaths.marker(".", task.id)} if it is not — then run the task again`;
}

function interruptedReason(task: Task, leftover: Leftover): string {
  const stopped =
    leftover.kind === "stopped"
      ? `; its runner (process group ${leftover.pgid}) was still running and was stopped`
      : "";
  const next =
    lastSession(task) === null
      ? `start it again with \`groot task run ${task.id}\``
      : `continue with \`groot task resume ${task.id}\``;
  return `the groot process running it exited unexpectedly${stopped} — ${next}`;
}

/** A crashed attempt, closed: interrupted, its session kept only if it was established. */
async function closeCrashed(root: string, task: Task, attempt: Attempt): Promise<Attempt> {
  if (attempt.status !== "running") return attempt;
  const log = await readFile(taskPaths.attemptLog(root, task.id, attempt.n), "utf8").catch(
    () => "",
  );
  return {
    ...attempt,
    status: "interrupted",
    finishedAt: nowIso(),
    sessionId: logShowsSession(log) ? attempt.sessionId : null,
  };
}

/** The marker of a task recorded as running, when its run was abandoned (null: really running). */
async function abandonedMarker(root: string, task: Task): Promise<RunMarker | null | "live"> {
  const marker = await readMarker(root, task.id);
  return marker !== null && isLiveMarker(marker) ? "live" : marker;
}

/**
 * A task recorded as running whose Groot process is gone becomes
 * interrupted — after its leftover runner is stopped (see the module
 * comment). Returns the task unchanged while it really runs.
 */
export async function reconcile(root: string, task: Task): Promise<Task> {
  if (task.status !== "running") return task;
  const marker = await abandonedMarker(root, task);
  if (marker === "live") return task;
  const leftover = await leftoverRunner(marker, true);
  if (leftover.kind === "alive" || leftover.kind === "survived") {
    return { ...task, statusReason: runningReason(task, leftover) };
  }
  clearMarker(root, task.id);
  const attempts = await Promise.all(
    task.attempts.map((attempt) => closeCrashed(root, task, attempt)),
  );
  const closed = { ...task, attempts };
  return writeTask(
    root,
    touch(closed, { status: "interrupted", statusReason: interruptedReason(closed, leftover) }),
  );
}

/** What reconcile would make of a task — computed without writing or signalling anything. */
export async function viewTask(root: string, task: Task): Promise<Task> {
  if (task.status !== "running") return task;
  const marker = await abandonedMarker(root, task);
  if (marker === "live") return task;
  const leftover = await leftoverRunner(marker, false);
  if (leftover.kind !== "none") return { ...task, statusReason: runningReason(task, leftover) };
  const attempts = await Promise.all(
    task.attempts.map((attempt) => closeCrashed(root, task, attempt)),
  );
  const closed = { ...task, attempts };
  return { ...closed, status: "interrupted", statusReason: interruptedReason(closed, leftover) };
}

/** A task as surfaces show it (task show, MCP): an abandoned run appears as it will be reconciled. */
export async function showTask(root: string, id: string): Promise<Task> {
  return viewTask(root, await readTask(root, id));
}

/** Every task as surfaces show it (task list, MCP). */
export async function showTasks(root: string): Promise<Task[]> {
  return Promise.all((await listTasks(root)).map((task) => viewTask(root, task)));
}
