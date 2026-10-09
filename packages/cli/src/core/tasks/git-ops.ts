/**
 * Git operations for tasks: canonical repository roots, task/integration
 * worktrees, Groot's own commits, merges, cleanliness checks, and ref
 * snapshots (what an attempt moved). Every call
 * is an argv array (never a shell), bounded by a timeout, and configured to
 * never prompt or open an editor. Groot commits with the user's identity
 * when one is configured, otherwise as `groot <groot@localhost>`.
 *
 * Groot's own git never runs repository hooks (`core.hooksPath=/dev/null`)
 * or an fsmonitor command: code Groot has not reviewed (the agent's, under
 * the pre-review checks) can write the shared git directory, and a hook or
 * fsmonitor planted there must not run inside Groot's next git command with
 * Groot's environment. Task commits are bookkeeping on a task branch —
 * acceptance checks and review are the gates — and they never stage new
 * files under `node_modules` (dependency installs Groot runs in worktrees).
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { GrootV2Error } from "../errors.ts";
import { runProcess, type SpawnResult, tail } from "../process.ts";

export type Env = Readonly<Record<string, string | undefined>>;

const GIT_TIMEOUT_MS = 120_000;
/** Prepended to every git command Groot runs (see the module comment). */
export const GIT_SAFETY_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];
/** New files under any node_modules directory are never committed by Groot. */
const NOT_NODE_MODULES = ":(exclude,glob)**/node_modules/**";

export function gitEnv(base: Env): Record<string, string | undefined> {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    LC_ALL: "C",
  };
}

export function gitRun(cwd: string, args: readonly string[], env: Env): Promise<SpawnResult> {
  return runProcess({
    argv: ["git", ...GIT_SAFETY_ARGS, ...args],
    cwd,
    env: gitEnv(env),
    timeoutMs: GIT_TIMEOUT_MS,
    killGraceMs: 1000,
  });
}

/** Run git and return stdout, or throw with the command and its error tail. */
export async function gitOut(
  cwd: string,
  args: readonly string[],
  env: Env,
  what: string,
): Promise<string> {
  const result = await gitRun(cwd, args, env);
  if (result.exitCode !== 0) {
    throw new GrootV2Error(
      "GROOT_E_COMMAND_FAILED",
      `${what} failed (git ${args.join(" ")}): ${tail(result.stderr || result.stdout, 5)}`,
    );
  }
  return result.stdout;
}

/**
 * Run git and return its stdout UNREDACTED. Only for in-memory analysis that
 * must see real content — the review's secret scan, which reports locations
 * and kinds, never values (runProcess redacts captures, which would hide the
 * very secrets the scan looks for). Never persist this output.
 */
export async function gitReadRaw(
  cwd: string,
  args: readonly string[],
  env: Env,
  what: string,
): Promise<string> {
  const proc = Bun.spawn(["git", ...GIT_SAFETY_ARGS, ...args], {
    cwd,
    env: gitEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new GrootV2Error("GROOT_E_COMMAND_FAILED", `${what} failed: ${tail(stderr, 5)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/** Commit id for a revision, or null when it doesn't resolve. */
export async function revParse(cwd: string, rev: string, env: Env): Promise<string | null> {
  const result = await gitRun(cwd, ["rev-parse", "--verify", "-q", `${rev}^{commit}`], env);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function currentBranch(cwd: string, env: Env): Promise<string | null> {
  const result = await gitRun(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], env);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * The canonical (realpath) repository root for `dir`. Tasks operate on a
 * whole repository, so `dir` must be its top level; the repository needs at
 * least one commit (a task branches from it).
 */
export async function repositoryRoot(dir: string, env: Env): Promise<string> {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new GrootV2Error("GROOT_E_USAGE", `${dir} does not exist.`);
  }
  const top = await gitRun(real, ["rev-parse", "--show-toplevel"], env);
  if (top.exitCode !== 0) {
    throw new GrootV2Error("GROOT_E_USAGE", `${real} is not inside a git repository.`, {
      hint: "Tasks run in git worktrees: `git init` and commit once, then create the task.",
    });
  }
  const topReal = realpathSync(top.stdout.trim());
  if (topReal !== real) {
    throw new GrootV2Error(
      "GROOT_E_USAGE",
      `Tasks are managed from the repository root (${topReal}).`,
      {
        hint: `Run the command from ${topReal}.`,
      },
    );
  }
  if ((await revParse(real, "HEAD", env)) === null) {
    throw new GrootV2Error("GROOT_E_USAGE", "The repository has no commits yet.", {
      hint: "Commit once (tasks branch from a commit), then retry.",
    });
  }
  return real;
}

export async function statusEntries(cwd: string, env: Env): Promise<string[]> {
  const result = await gitRun(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], env);
  if (result.exitCode !== 0) return ["(git status failed)"];
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** Common git directories already located (cwd + the env that can redirect it → path). */
const commonDirs = new Map<string, string>();

/** Absolute path of the repository's common git directory (shared by every worktree). */
export async function gitCommonDir(cwd: string, env: Env): Promise<string> {
  const key = [cwd, env.GIT_DIR ?? "", env.GIT_COMMON_DIR ?? ""].join("\0");
  const known = commonDirs.get(key);
  if (known !== undefined && existsSync(known)) return known;
  const out = await gitOut(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    env,
    "Locating the git directory",
  );
  const path = realpathSync(out.trim());
  commonDirs.set(key, path);
  return path;
}

/** Is `path` (relative to `cwd`) git-ignored there? */
export async function isIgnored(cwd: string, path: string, env: Env): Promise<boolean> {
  return (await gitRun(cwd, ["check-ignore", "-q", path], env)).exitCode === 0;
}

/** Name → value of every ref, plus each checkout's HEAD (symbolic target or commit). */
export type RefSnapshot = ReadonlyMap<string, string>;

async function headOf(cwd: string, env: Env): Promise<string> {
  const symbolic = await gitRun(cwd, ["symbolic-ref", "-q", "HEAD"], env);
  if (symbolic.exitCode === 0) return `ref: ${symbolic.stdout.trim()}`;
  return (await revParse(cwd, "HEAD", env)) ?? "(none)";
}

/**
 * Every ref in the repository and the HEADs of the main checkout and the
 * task worktree — compared before and after an attempt. Read raw (exact
 * names; this never leaves memory unredacted).
 */
export async function refSnapshot(root: string, worktree: string, env: Env): Promise<RefSnapshot> {
  const [refs, head, worktreeHead] = await Promise.all([
    gitReadRaw(
      root,
      ["for-each-ref", "--format=%(refname) %(objectname)"],
      env,
      "Listing the repository's refs",
    ),
    headOf(root, env),
    headOf(worktree, env),
  ]);
  const snapshot = new Map<string, string>();
  for (const line of refs.split("\n")) {
    const [name, object] = line.split(" ");
    if (name !== undefined && name !== "" && object !== undefined) snapshot.set(name, object);
  }
  snapshot.set("HEAD", head);
  snapshot.set("HEAD (task worktree)", worktreeHead);
  return snapshot;
}

/** A ref's value in a snapshot, as shown in a change list. */
function shortRef(value: string | undefined): string {
  if (value === undefined) return "(none)";
  return value.startsWith("ref: ") ? value.slice(5) : value.slice(0, 12);
}

/**
 * Refs that differ between two snapshots (added, removed, or moved), as
 * "name a → b" — except those `mayMove` accepts (it sees the full values).
 */
export function refChanges(
  before: RefSnapshot,
  after: RefSnapshot,
  mayMove: (name: string, from: string | undefined, to: string | undefined) => boolean,
): string[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names
    .filter((name) => before.get(name) !== after.get(name))
    .filter((name) => !mayMove(name, before.get(name), after.get(name)))
    .map((name) => `${name} ${shortRef(before.get(name))} → ${shortRef(after.get(name))}`);
}

/** Identity flags for Groot's commits: the user's when configured, else groot's. */
async function identityArgs(cwd: string, env: Env): Promise<string[]> {
  const [name, email] = await Promise.all([
    gitRun(cwd, ["config", "user.name"], env),
    gitRun(cwd, ["config", "user.email"], env),
  ]);
  const configured =
    name.exitCode === 0 &&
    name.stdout.trim() !== "" &&
    email.exitCode === 0 &&
    email.stdout.trim() !== "";
  return configured ? [] : ["-c", "user.name=groot", "-c", "user.email=groot@localhost"];
}

/**
 * Stage every change in a worktree — except new files under node_modules
 * directories (installs a `/node_modules/` pattern does not ignore, e.g. a
 * workspace package's own node_modules) — and commit it; no-op when nothing
 * changed. Changes to files already tracked are always staged.
 */
export async function commitAll(
  cwd: string,
  message: string,
  env: Env,
): Promise<{ committed: boolean; head: string }> {
  await gitOut(cwd, ["add", "-A", "--", ".", NOT_NODE_MODULES], env, "Staging the task's changes");
  await gitOut(cwd, ["add", "-u"], env, "Staging the task's changes");
  const staged = await gitRun(cwd, ["diff", "--cached", "--quiet"], env);
  if (staged.exitCode === 0) {
    return { committed: false, head: (await revParse(cwd, "HEAD", env)) ?? "" };
  }
  const identity = await identityArgs(cwd, env);
  await gitOut(
    cwd,
    [...identity, "commit", "--no-verify", "-q", "-m", message],
    env,
    "Committing the task's changes",
  );
  return { committed: true, head: (await revParse(cwd, "HEAD", env)) ?? "" };
}

async function isWorktreeAt(path: string, env: Env): Promise<boolean> {
  if (!existsSync(path)) return false;
  const top = await gitRun(path, ["rev-parse", "--show-toplevel"], env);
  try {
    return top.exitCode === 0 && realpathSync(top.stdout.trim()) === realpathSync(path);
  } catch {
    return false;
  }
}

/**
 * Ensure a worktree for `branch` exists at `path` (Groot-owned, under
 * .groot/worktrees). Reuses a live one; recreates a stale directory; creates
 * the branch from `startPoint` when it doesn't exist yet. Returns the realpath.
 */
export async function ensureWorktree(
  root: string,
  path: string,
  branch: string,
  startPoint: string,
  env: Env,
): Promise<string> {
  if (await isWorktreeAt(path, env)) return realpathSync(path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await gitRun(root, ["worktree", "prune"], env);
  const exists = (await revParse(root, `refs/heads/${branch}`, env)) !== null;
  const args = exists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, startPoint];
  await gitOut(root, args, env, "Creating the task worktree");
  return realpathSync(path);
}

/** A brand-new worktree on `branch`, reset to `startPoint` (integration). */
export async function freshWorktree(
  root: string,
  path: string,
  branch: string,
  startPoint: string,
  env: Env,
): Promise<string> {
  await removeWorktree(root, path, env);
  await gitOut(
    root,
    ["worktree", "add", "-B", branch, path, startPoint],
    env,
    "Creating the integration worktree",
  );
  return realpathSync(path);
}

/** Remove a Groot-owned worktree (its branch is kept for audit). */
export async function removeWorktree(root: string, path: string, env: Env): Promise<void> {
  if (existsSync(path)) {
    const removed = await gitRun(root, ["worktree", "remove", "--force", path], env);
    if (removed.exitCode !== 0 && existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  await gitRun(root, ["worktree", "prune"], env);
}

export async function deleteBranch(root: string, branch: string, env: Env): Promise<void> {
  await gitRun(root, ["branch", "-D", branch], env);
}

export interface MergeOutcome {
  readonly ok: boolean;
  readonly conflicts: readonly string[];
  readonly detail: string;
}

/** `git merge --no-ff` in an integration worktree; conflicts are aborted and reported. */
export async function mergeNoFf(
  cwd: string,
  ref: string,
  message: string,
  env: Env,
): Promise<MergeOutcome> {
  const identity = await identityArgs(cwd, env);
  const result = await gitRun(
    cwd,
    [...identity, "merge", "--no-ff", "--no-verify", "--no-edit", "-m", message, ref],
    env,
  );
  if (result.exitCode === 0) return { ok: true, conflicts: [], detail: "" };
  const unmerged = await gitRun(cwd, ["diff", "--name-only", "--diff-filter=U"], env);
  await gitRun(cwd, ["merge", "--abort"], env);
  return {
    ok: false,
    conflicts: unmerged.stdout.split("\n").filter((line) => line.trim() !== ""),
    detail: tail(`${result.stdout}\n${result.stderr}`, 5),
  };
}
