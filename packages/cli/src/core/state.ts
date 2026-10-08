/**
 * Layout of `.groot/` — Groot's local, gitignored operation state:
 *
 *   .groot/.gitignore            "*" — the directory ignores itself; the
 *                                project's own .gitignore is never edited for it
 *   .groot/lock.json             writer lock (core/fs/lock.ts)
 *   .groot/plans/<planId>.json   saved plans
 *   .groot/operations/<opId>/    plan.json · journal.jsonl · state.json · backups/ · logs/
 *   .groot/evidence/<evId>/      evidence.json + redacted artifacts
 *   .groot/tasks/<taskId>/       task.json · prompt.md · attempt-<n>.jsonl
 *   .groot/reviews/<revId>.json
 *
 * Portable state (groot.json, groot.lock.json) lives at the project root and
 * is committed.
 *
 * A repository can ship anything at these paths, including symlinks, so state
 * paths are contained: `.groot/` must be a real directory inside the project,
 * no existing component below it may be a symlink, and ids are validated
 * before they become path segments.
 */
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { z } from "zod";
import { EvidenceId, OperationId, PlanId, TaskId } from "./contracts/common.ts";
import { GrootV2Error } from "./errors.ts";

export const STATE_DIR_NAME = ".groot";

const IGNORE_FILE_CONTENT =
  "# Groot local state (journals, backups, evidence, tasks) — never committed.\n*\n";

/** Not defined on Windows, where opening a symlink this way is not a concern. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined; // absent (ENOENT/ENOTDIR) — nothing there to follow
  }
}

function refuse(path: string, reason: string): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_PATH_OUTSIDE_PROJECT",
    `Refusing Groot state path "${path}": ${reason}.`,
    {
      hint: "Groot keeps its state in a real .groot/ directory inside the project; remove what is at that path and retry.",
      details: { path, reason },
    },
  );
}

/** `.groot/` when absent or a real directory inside the project — never a symlink. */
export function stateDir(root: string): string {
  const dir = join(root, STATE_DIR_NAME);
  const entry = lstatOrUndefined(dir);
  if (entry === undefined) return dir;
  if (entry.isSymbolicLink()) throw refuse(dir, "it is a symlink");
  if (!entry.isDirectory()) throw refuse(dir, "it is not a directory");
  const rel = relative(realpathSync(root), realpathSync(dir));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw refuse(dir, "it resolves outside the project root");
  }
  return dir;
}

/** Create `.gitignore` exclusively and never through a symlink; an existing file is left alone. */
function writeIgnoreFile(path: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lstatOrUndefined(path)?.isSymbolicLink()) throw refuse(path, "it is a symlink");
    return;
  }
  try {
    writeSync(fd, IGNORE_FILE_CONTENT);
  } finally {
    closeSync(fd);
  }
}

/** Create `.groot/` (self-ignoring) if needed; returns its absolute path. */
export function ensureStateDir(root: string): string {
  mkdirSync(stateDir(root), { recursive: true });
  const dir = stateDir(root); // re-check what now exists
  writeIgnoreFile(join(dir, ".gitignore"));
  return dir;
}

/**
 * A path under `.groot/`: every component that already exists must not be a
 * symlink (and all but the last must be directories), so a committed link
 * cannot redirect state writes or reads outside the project.
 */
function statePath(root: string, ...segments: readonly string[]): string {
  let current = stateDir(root);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = lstatOrUndefined(current);
    if (entry === undefined) return join(current, ...segments.slice(index + 1));
    if (entry.isSymbolicLink()) throw refuse(current, "it is a symlink");
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw refuse(current, "it is not a directory");
    }
  }
  return current;
}

/** An id that is safe to use as a path segment, or GROOT_E_USAGE. */
function checkedId(kind: string, schema: z.ZodType<string>, id: string): string {
  if (!schema.safeParse(id).success) {
    throw new GrootV2Error("GROOT_E_USAGE", `"${id}" is not a valid ${kind} id.`, {
      details: { kind, id },
    });
  }
  return id;
}

export const statePaths = {
  plans: (root: string): string => statePath(root, "plans"),
  plan: (root: string, planId: string): string =>
    statePath(root, "plans", `${checkedId("plan", PlanId, planId)}.json`),
  operations: (root: string): string => statePath(root, "operations"),
  operation: (root: string, operationId: string): string =>
    statePath(root, "operations", checkedId("operation", OperationId, operationId)),
  evidenceRoot: (root: string): string => statePath(root, "evidence"),
  evidence: (root: string, evidenceId: string): string =>
    statePath(root, "evidence", checkedId("evidence", EvidenceId, evidenceId)),
  tasks: (root: string): string => statePath(root, "tasks"),
  task: (root: string, taskId: string): string =>
    statePath(root, "tasks", checkedId("task", TaskId, taskId)),
  reviews: (root: string): string => statePath(root, "reviews"),
  cache: (root: string): string => statePath(root, "cache"),
};
