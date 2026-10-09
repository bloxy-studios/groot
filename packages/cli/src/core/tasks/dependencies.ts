/**
 * Dependencies for the checks in a task or integration worktree. Worktrees
 * live inside the project (.groot/worktrees/<id>), so without node_modules
 * of their own, Bun resolves packages — the project's own workspace packages
 * included — from the MAIN checkout's node_modules: checks would test the
 * main checkout's code instead of the change. So before any check, a
 * worktree with a Bun lockfile gets `bun install --frozen-lockfile` (run by
 * acceptance.ts as evidence; a failure blocks the checks). Without a
 * lockfile, or when node_modules is not git-ignored (Groot would commit it),
 * nothing is installed and every piece of evidence says what that means.
 *
 * "Ignored" is asked about a file INSIDE node_modules: a fresh worktree has
 * no node_modules yet, and directory-only patterns (`node_modules/`,
 * `/node_modules/` — GitHub's Node template, Expo, Hono) match a path that
 * does not exist only when git can tell it is a directory. Nested
 * node_modules a root-only pattern leaves unignored (a workspace package's
 * own, from Bun's isolated installs) are never committed either: Groot's
 * commits skip new files under node_modules (git-ops.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Env, isIgnored } from "./git-ops.ts";

export const INSTALL_ARGV: readonly string[] = ["bun", "install", "--frozen-lockfile"];
export const INSTALL_TIMEOUT_MS = 600_000;
/** A file the install would create — asked about instead of the (missing) directory. */
const NODE_MODULES_PROBE = "node_modules/.groot-install-probe";

const NO_LOCKFILE =
  "the worktree has no bun.lock, so no dependencies were installed in it: packages can resolve from the main checkout's node_modules";
const NOT_IGNORED =
  "node_modules is not git-ignored, so no dependencies were installed in the worktree (Groot would commit them): packages can resolve from the main checkout's node_modules";
const INSTALLED =
  "dependencies were installed in the worktree; an import its packages do not declare can still resolve from the main checkout's node_modules";

export interface DependencyPlan {
  /** Run INSTALL_ARGV in the worktree before the checks. */
  readonly install: boolean;
  /** What every check of the run must state about module resolution. */
  readonly limitations: readonly string[];
}

/** Whether (and with what caveat) dependencies get installed into `cwd`. */
export async function dependencyPlan(cwd: string, env: Env): Promise<DependencyPlan> {
  if (!existsSync(join(cwd, "package.json"))) return { install: false, limitations: [] };
  if (!["bun.lock", "bun.lockb"].some((name) => existsSync(join(cwd, name)))) {
    return { install: false, limitations: [NO_LOCKFILE] };
  }
  if (!(await isIgnored(cwd, NODE_MODULES_PROBE, env))) {
    return { install: false, limitations: [NOT_IGNORED] };
  }
  return { install: true, limitations: [INSTALLED] };
}
