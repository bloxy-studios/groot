/**
 * Task persistence under `.groot/` (local, self-ignoring):
 *
 *   .groot/tasks/<taskId>/task.json            the Task document (atomic, validated)
 *   .groot/tasks/<taskId>/prompt.md            every prompt sent, per attempt
 *   .groot/tasks/<taskId>/attempt-<n>.jsonl    redacted runner event log
 *   .groot/tasks/<taskId>/acceptance-<n>.json  per-criterion results of attempt n
 *   .groot/tasks/<taskId>/runner.json          live-run marker while running (groot
 *                                              pid/host; the runner's process group
 *                                              while a runner process exists)
 *   .groot/reviews/<reviewId>.json             Review documents
 *   .groot/worktrees/<taskId>                  the task's git worktree
 *
 * Every document read here is untrusted input and is validated against its
 * contract (unparseable or invalid → GROOT_E_INVALID_DOCUMENT); ids are
 * checked before they become path segments.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ReviewId, TaskId } from "../contracts/common.ts";
import { EvidenceStatus } from "../contracts/evidence.ts";
import { Review, Task } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { isProcessAlive } from "../fs/lock.ts";
import { toProjectPath } from "../fs/paths.ts";
import { nowIso } from "../ids.ts";
import { prettyJson } from "../json.ts";
import { ensureStateDir, stateDir, statePaths } from "../state.ts";

export const taskPaths = {
  dir: (root: string, id: string): string => statePaths.task(root, id),
  file: (root: string, id: string): string => join(statePaths.task(root, id), "task.json"),
  prompt: (root: string, id: string): string => join(statePaths.task(root, id), "prompt.md"),
  attemptLog: (root: string, id: string, n: number): string =>
    join(statePaths.task(root, id), `attempt-${n}.jsonl`),
  acceptance: (root: string, id: string, n: number): string =>
    join(statePaths.task(root, id), `acceptance-${n}.json`),
  marker: (root: string, id: string): string => join(statePaths.task(root, id), "runner.json"),
  review: (root: string, id: string): string => join(statePaths.reviews(root), `${id}.json`),
  worktrees: (root: string): string => join(stateDir(root), "worktrees"),
  worktree: (root: string, name: string): string => join(stateDir(root), "worktrees", name),
};

export const taskBranch = (id: string): string => `groot/task/${id}`;
export const integrationBranch = (id: string): string => `groot/integrate/${id}`;

export function assertTaskId(id: string): string {
  if (!TaskId.safeParse(id).success) {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `"${id}" is not a task id.`, {
      hint: "Task ids look like task_… — list them with `groot task list`.",
    });
  }
  return id;
}

/** A new task object with the patch applied and updatedAt refreshed (never mutates). */
export function touch(task: Task, patch: Partial<Task>): Task {
  return { ...task, ...patch, updatedAt: nowIso() };
}

/** Parse an untrusted JSON document against its contract; invalid → GROOT_E_INVALID_DOCUMENT. */
function parseDocument<T>(schema: z.ZodType<T>, raw: string, what: string, path: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GrootV2Error("GROOT_E_INVALID_DOCUMENT", `${what} is not valid JSON.`, {
      hint: `Inspect or remove ${path}.`,
      details: { path },
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new GrootV2Error("GROOT_E_INVALID_DOCUMENT", `${what} is not a valid document.`, {
      hint: `Inspect or remove ${path}.`,
      details: { path, issues: parsed.error.issues.slice(0, 5) },
    });
  }
  return parsed.data;
}

export async function readTask(root: string, id: string): Promise<Task> {
  assertTaskId(id);
  const path = taskPaths.file(root, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `No task ${id} in this project.`, {
      hint: "List tasks with `groot task list`.",
    });
  }
  return parseDocument(Task, raw, `Task ${id}`, path);
}

/** Validate and persist atomically; returns the stored document. */
export function writeTask(root: string, task: Task): Task {
  const valid = Task.parse(task);
  ensureStateDir(root);
  writeFileAtomic(taskPaths.file(root, valid.id), prettyJson(valid));
  return valid;
}

/** All tasks, oldest first (ids are time-sortable); unreadable entries are skipped. */
export async function listTasks(root: string): Promise<Task[]> {
  let names: string[];
  try {
    names = await readdir(statePaths.tasks(root));
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const name of names.filter((entry) => TaskId.safeParse(entry).success).sort()) {
    try {
      tasks.push(await readTask(root, name));
    } catch {
      // a torn or foreign directory is not fatal for listing
    }
  }
  return tasks;
}

export function appendPrompt(root: string, id: string, heading: string, prompt: string): void {
  mkdirSync(taskPaths.dir(root, id), { recursive: true });
  appendFileSync(taskPaths.prompt(root, id), `## ${heading}\n\n${prompt.trimEnd()}\n\n`);
}

/** Project-relative path of an attempt log (the contract stores RelPath). */
export function attemptLogRel(root: string, id: string, n: number): string {
  return toProjectPath(root, taskPaths.attemptLog(root, id, n));
}

// ---------------------------------------------------------------- reviews

export function saveReview(root: string, review: Review): Review {
  const valid = Review.parse(review);
  writeFileAtomic(taskPaths.review(root, valid.id), prettyJson(valid));
  return valid;
}

export async function readReview(root: string, id: string): Promise<Review> {
  if (!ReviewId.safeParse(id).success) {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `"${id}" is not a review id.`);
  }
  const path = taskPaths.review(root, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `No review ${id} in this project.`);
  }
  return parseDocument(Review, raw, `Review ${id}`, path);
}

// ------------------------------------------------------- acceptance results

export const AcceptanceRecord = z
  .object({
    criterion: z.string(),
    status: EvidenceStatus,
    evidence: z.array(z.string()),
    summary: z.string(),
    /** Redacted output tail for failures (fed back to the agent on retry). */
    tail: z.string(),
  })
  .strict();
export type AcceptanceRecord = z.infer<typeof AcceptanceRecord>;

export function writeAcceptance(
  root: string,
  id: string,
  n: number,
  records: readonly AcceptanceRecord[],
): void {
  writeFileAtomic(taskPaths.acceptance(root, id, n), prettyJson(records));
}

/** Acceptance results of the most recent attempt that ran them (null when none did). */
export async function latestAcceptance(
  root: string,
  task: Task,
): Promise<AcceptanceRecord[] | null> {
  for (const attempt of [...task.attempts].reverse()) {
    try {
      const raw = await readFile(taskPaths.acceptance(root, task.id, attempt.n), "utf8");
      return z.array(AcceptanceRecord).parse(JSON.parse(raw));
    } catch {
      // that attempt ran no acceptance checks
    }
  }
  return null;
}

// ------------------------------------------------- attempt result sidecars

const AttemptSummary = z
  .object({ status: z.string(), simulated: z.boolean(), notes: z.array(z.string()) })
  .strict();
export type AttemptSummary = z.infer<typeof AttemptSummary>;

const attemptSummaryPath = (root: string, id: string, n: number): string =>
  join(statePaths.task(root, id), `attempt-${n}.result.json`);

/** Facts the Attempt contract has no field for (simulated flag, runner notes). */
export function writeAttemptSummary(
  root: string,
  id: string,
  n: number,
  summary: AttemptSummary,
): void {
  writeFileAtomic(attemptSummaryPath(root, id, n), prettyJson(summary));
}

export async function readAttemptSummary(
  root: string,
  id: string,
  n: number,
): Promise<AttemptSummary | null> {
  try {
    return AttemptSummary.parse(
      JSON.parse(await readFile(attemptSummaryPath(root, id, n), "utf8")),
    );
  } catch {
    return null;
  }
}

/** Did any attempt of this task run on a simulated runner? */
export async function producedBySimulation(root: string, task: Task): Promise<boolean> {
  for (const attempt of task.attempts) {
    if ((await readAttemptSummary(root, task.id, attempt.n))?.simulated === true) return true;
  }
  return false;
}

// ---------------------------------------------------------- run markers

/**
 * runner.json while a task runs: the Groot process (pid/host) and — while a
 * runner process exists — the runner's process group and spawn time, so a
 * later Groot can stop a runner that a killed predecessor left behind.
 */
const RunMarker = z
  .object({
    pid: z.number().int(),
    host: z.string(),
    at: z.string(),
    runner: z
      .object({ pgid: z.number().int().positive(), startedAt: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export type RunMarker = z.infer<typeof RunMarker>;

/** Record this process as the task's runner (with the live runner group, when there is one). */
export function writeMarker(root: string, id: string, runner?: RunMarker["runner"]): void {
  mkdirSync(taskPaths.dir(root, id), { recursive: true });
  const marker: RunMarker = { pid: process.pid, host: hostname(), at: nowIso(), runner };
  writeFileSync(taskPaths.marker(root, id), JSON.stringify(marker));
}

export function clearMarker(root: string, id: string): void {
  rmSync(taskPaths.marker(root, id), { force: true });
}

/** The task's run marker, or null when there is none (or it is unreadable). */
export async function readMarker(root: string, id: string): Promise<RunMarker | null> {
  try {
    return RunMarker.parse(JSON.parse(await readFile(taskPaths.marker(root, id), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Does a marker belong to a live run? A live local process (or another
 * host, which can't be checked) counts as running; a dead local process
 * means the run was abandoned.
 */
export function isLiveMarker(marker: RunMarker): boolean {
  return marker.host !== hostname() || isProcessAlive(marker.pid);
}
