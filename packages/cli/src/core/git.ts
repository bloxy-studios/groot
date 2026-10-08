/**
 * Read-only git facts: revision identity and working-tree state. Evidence and
 * plans record these so results are tied to what was actually checked — a
 * dirty tree carries a fingerprint of its uncommitted content, not just HEAD.
 *
 * These probes must not run commands that a repository or the inherited
 * environment configures: every GIT_* variable is dropped (GIT_CONFIG_*,
 * GIT_EXTERNAL_DIFF, GIT_DIR, …), the fsmonitor hook is disabled, and diffs
 * use neither external drivers nor textconv. Clean/smudge filter drivers in
 * the repository's own .git/config cannot be disabled by flags — an untrusted
 * `.git` (e.g. from an extracted archive) is unsafe to inspect in place.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RevisionInfo, Sha256 } from "./contracts/common.ts";
import type { GitState } from "./contracts/project.ts";
import { sha256Of } from "./fs/hash.ts";

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Overrides that keep repository configuration from running commands. */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false"] as const;

/** Diff flags that keep diff.external, GIT_EXTERNAL_DIFF, and textconv drivers from running. */
const SAFE_DIFF = ["--binary", "--no-ext-diff", "--no-textconv"] as const;

/** git's empty tree in the sha1 object format (fallback when it can't be computed). */
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The inherited environment without git's own variables, plus stable output settings. */
function childEnv(): Record<string, string | undefined> {
  const inherited = Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("GIT_"),
  );
  return { ...Object.fromEntries(inherited), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...SAFE_CONFIG, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: childEnv(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Repository top-level containing `dir`, or null when not in a git work tree. */
export async function gitTopLevel(dir: string): Promise<string | null> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

interface StatusEntries {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** Parse `git status --porcelain=v1 -z` (renames carry an extra NUL-separated source path). */
export function parsePorcelainZ(output: string): StatusEntries {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    const x = entry[0] as string;
    const y = entry[1] as string;
    const path = entry.slice(3);
    if (x === "?" && y === "?") {
      untracked.push(path);
      continue;
    }
    if (x === "!" && y === "!") continue;
    if (x !== " ") staged.push(path);
    if (y !== " ") unstaged.push(path);
    if (x === "R" || x === "C") i++; // skip the rename/copy source path
  }
  return { staged, unstaged, untracked };
}

/**
 * Full git state for `dir` (paths relative to `dir`'s repository top-level,
 * re-expressed relative to `dir` when it is a subdirectory).
 */
export async function gitState(dir: string): Promise<GitState> {
  const top = await gitTopLevel(dir);
  if (top === null) {
    return {
      vcs: "none",
      head: null,
      branch: null,
      dirty: false,
      worktreeFingerprint: null,
      staged: [],
      unstaged: [],
      untracked: [],
    };
  }
  const [headResult, branchResult, statusResult] = await Promise.all([
    git(dir, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]),
    git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
  ]);
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const entries = parsePorcelainZ(statusResult.stdout);
  // status paths are relative to the repo top; express them relative to dir.
  const prefixResult = await git(dir, ["rev-parse", "--show-prefix"]);
  const prefix = prefixResult.exitCode === 0 ? prefixResult.stdout.trim() : "";
  const strip = (path: string): string =>
    prefix !== "" && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const staged = entries.staged.map(strip);
  const unstaged = entries.unstaged.map(strip);
  const untracked = entries.untracked.map(strip);
  const dirty = staged.length + unstaged.length + untracked.length > 0;
  return {
    vcs: "git",
    head,
    branch,
    dirty,
    worktreeFingerprint: dirty ? await worktreeFingerprint(dir, head, untracked) : null,
    staged,
    unstaged,
    untracked,
  };
}

/** The empty tree in the repository's object format (sha1 or sha256). */
async function emptyTree(dir: string): Promise<string> {
  const result = await git(dir, ["hash-object", "-t", "tree", "--stdin"]);
  const id = result.stdout.trim();
  return result.exitCode === 0 && id !== "" ? id : EMPTY_TREE_SHA1;
}

async function worktreeFingerprint(
  dir: string,
  head: string | null,
  untracked: readonly string[],
): Promise<Sha256> {
  // Tracked content on disk against HEAD — or, before the first commit,
  // against the empty tree, so edits after `git add` still count.
  const base = head ?? (await emptyTree(dir));
  const diff = await git(dir, ["diff", base, ...SAFE_DIFF, "--", "."]);
  const parts: string[] = [diff.stdout];
  for (const path of [...untracked].sort()) {
    try {
      parts.push(`${path}\0${sha256Of(await readFile(join(dir, path)))}`);
    } catch {
      parts.push(`${path}\0unreadable`);
    }
  }
  return sha256Of(parts.join("\n"));
}

/** Revision identity only (the subset evidence and plans record). */
export async function revisionInfo(dir: string): Promise<RevisionInfo> {
  const state = await gitState(dir);
  return {
    vcs: state.vcs,
    head: state.head,
    branch: state.branch,
    dirty: state.dirty,
    worktreeFingerprint: state.worktreeFingerprint,
  };
}
