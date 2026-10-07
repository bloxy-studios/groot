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
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR_NAME = ".groot";

export function stateDir(root: string): string {
  return join(root, STATE_DIR_NAME);
}

/** Create `.groot/` (self-ignoring) if needed; returns its absolute path. */
export function ensureStateDir(root: string): string {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(
      ignore,
      "# Groot local state (journals, backups, evidence, tasks) — never committed.\n*\n",
    );
  }
  return dir;
}

export const statePaths = {
  plans: (root: string): string => join(stateDir(root), "plans"),
  plan: (root: string, planId: string): string => join(stateDir(root), "plans", `${planId}.json`),
  operations: (root: string): string => join(stateDir(root), "operations"),
  operation: (root: string, operationId: string): string =>
    join(stateDir(root), "operations", operationId),
  evidenceRoot: (root: string): string => join(stateDir(root), "evidence"),
  evidence: (root: string, evidenceId: string): string =>
    join(stateDir(root), "evidence", evidenceId),
  tasks: (root: string): string => join(stateDir(root), "tasks"),
  task: (root: string, taskId: string): string => join(stateDir(root), "tasks", taskId),
  reviews: (root: string): string => join(stateDir(root), "reviews"),
  cache: (root: string): string => join(stateDir(root), "cache"),
};
