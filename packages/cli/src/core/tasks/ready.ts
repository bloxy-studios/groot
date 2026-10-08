/**
 * `groot task run --ready`: run every task that can start now — pending (or
 * blocked before review, re-evaluated) with all dependencies completed — with
 * bounded parallelism (default 2, max 4). Tasks whose ownership overlaps a
 * task already in flight wait for it instead of running beside it, so two
 * agents never edit the same files at once. Abort stops scheduling and
 * interrupts the runs in flight through the same signal. A task that could
 * not even start (a git error creating its worktree, a lock held elsewhere)
 * is reported with its error — never mistaken for one that ran.
 */
import type { ErrorInfo } from "../contracts/envelope.ts";
import type { Task } from "../contracts/task.ts";
import { toErrorInfo } from "../errors.ts";
import type { CoreContext } from "../runtime.ts";
import { repositoryRoot } from "./git-ops.ts";
import { ownershipOverlap } from "./ownership.ts";
import { blockedAfterReview, runTask } from "./run.ts";
import { listTasks, readTask } from "./store.ts";
import { DEFAULT_PARALLEL, MAX_PARALLEL, type RunTaskOptions } from "./types.ts";

export function clampParallel(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PARALLEL;
  return Math.min(MAX_PARALLEL, Math.max(1, Math.floor(value)));
}

/** Can this task start now (status and dependencies only)? */
export function isReady(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  const waiting =
    task.status === "pending" || (task.status === "blocked" && !blockedAfterReview(task));
  return waiting && task.dependsOn.every((id) => byId.get(id)?.status === "completed");
}

/** A task that could not be started, and why (its state is whatever it was). */
export interface StartFailure {
  readonly taskId: string;
  readonly error: ErrorInfo;
}

export interface ReadyRun {
  /** Final states of every scheduled task (including those that could not start). */
  readonly tasks: Task[];
  readonly failures: StartFailure[];
}

interface Outcome {
  readonly task: Task;
  readonly failure: StartFailure | null;
}

interface InFlight {
  readonly task: Task;
  readonly done: Promise<Outcome>;
}

async function runOne(
  ctx: CoreContext,
  root: string,
  task: Task,
  options: RunTaskOptions,
): Promise<Outcome> {
  try {
    return { task: await runTask(ctx, root, task.id, options), failure: null };
  } catch (error) {
    const info = toErrorInfo(error);
    ctx.events.emit({
      type: "task.warning",
      level: "warn",
      message: `${task.id}: not run — ${info.message}`,
      taskId: task.id,
    });
    const current = await readTask(root, task.id).catch(() => task);
    return { task: current, failure: { taskId: task.id, error: info } };
  }
}

/** Run every ready task (see the module comment); returns their final states and start failures. */
export async function runReadyTasks(
  ctx: CoreContext,
  root: string,
  options: { parallel: number } & RunTaskOptions,
): Promise<ReadyRun> {
  const repo = await repositoryRoot(root, ctx.env);
  const parallel = clampParallel(options.parallel);
  const all = await listTasks(repo);
  const byId = new Map(all.map((task) => [task.id, task]));
  const queue = all.filter((task) => isReady(task, byId));
  ctx.events.emit({
    type: "task.schedule",
    level: "info",
    message: `${queue.length} ready task(s); running up to ${parallel} at a time`,
    data: { ready: queue.map((task) => task.id), parallel },
  });
  const results: Outcome[] = [];
  const inFlight = new Map<string, InFlight>();
  while (!ctx.signal.aborted && (queue.length > 0 || inFlight.size > 0)) {
    for (const task of [...queue]) {
      if (inFlight.size >= parallel) break;
      const busy = [...inFlight.values()].some(
        (entry) => ownershipOverlap(task.ownership, entry.task.ownership) !== null,
      );
      if (busy) continue;
      queue.splice(queue.indexOf(task), 1);
      inFlight.set(task.id, { task, done: runOne(ctx, repo, task, options) });
    }
    if (inFlight.size === 0) break;
    const finished = await Promise.race(
      [...inFlight.values()].map((entry) =>
        entry.done.then((outcome) => ({ id: entry.task.id, outcome })),
      ),
    );
    inFlight.delete(finished.id);
    results.push(finished.outcome);
  }
  for (const entry of inFlight.values()) results.push(await entry.done);
  return {
    tasks: results.map((outcome) => outcome.task),
    failures: results.flatMap((outcome) => (outcome.failure === null ? [] : [outcome.failure])),
  };
}
