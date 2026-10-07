/**
 * Read-only git facts: revision identity and working-tree state. Evidence and
 * plans record these so results are tied to what was actually checked — a
 * dirty tree carries a fingerprint of its uncommitted content, not just HEAD.
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

export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
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

async function worktreeFingerprint(
  dir: string,
  head: string | null,
  untracked: readonly string[],
): Promise<Sha256> {
  const diff = await git(
    dir,
    head === null
      ? ["diff", "--cached", "--binary", "--", "."]
      : ["diff", head, "--binary", "--", "."],
  );
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
