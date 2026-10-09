/**
 * The repository guard: while code Groot did not write runs — the agent
 * (attempt.ts), the agent's code under Groot's pre-review acceptance checks
 * (run.ts), the approved change under integration's fresh checks
 * (integrate.ts) — nothing outside the worktree's files may change in the
 * repository. A snapshot holds:
 *
 * - every git ref, plus the HEADs of the main checkout and of the worktree
 *   in use;
 * - the git directory's executable surface — `config`, `config.worktree`,
 *   `hooks/`, `info/` (attributes, exclude), and each linked worktree's
 *   `config.worktree` (content hash, executable bit, symlink target) —
 *   what makes the next git command, Groot's or the user's, run code.
 *
 * Comparing two snapshots lists every change except other tasks' Groot
 * branches (parallel runs and integrations), remote-tracking refs
 * (background fetches), and a target branch fast-forwarded by Groot's own
 * integration of another task (journaled in `.groot/ref-moves.jsonl` BEFORE
 * the fast-forward). The task's own branches must not move inside a window:
 * Groot moves them only between windows. Changes to the main checkout's
 * files are reported separately — a warning, since the user may be editing
 * it.
 *
 * This detects; it does not confine. Unreviewed code without an OS sandbox
 * can write anywhere the user can — the evidence says so.
 */
import { appendFileSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256Of } from "../fs/hash.ts";
import { nowIso } from "../ids.ts";
import type { CoreContext } from "../runtime.ts";
import { ensureStateDir, stateDir } from "../state.ts";
import {
  type Env,
  gitCommonDir,
  type RefSnapshot,
  refChanges,
  refSnapshot,
  statusEntries,
} from "./git-ops.ts";
import { integrationBranch, taskBranch } from "./store.ts";

/** Files of the git directory's surface read at most per snapshot (hooks/ may hold samples). */
const SURFACE_LIMIT = 2000;
/** Journal entries considered (the most recent). */
const JOURNAL_LIMIT = 1000;
const SURFACE_ROOTS = ["config", "config.worktree", "hooks", "info"];

export interface GuardSnapshot {
  readonly refs: RefSnapshot;
  /** Path relative to the git common dir → content fingerprint. */
  readonly gitDir: ReadonlyMap<string, string>;
  /** The git common dir (absolute). */
  readonly commonDir: string;
}

/** A ref move Groot made itself (integration fast-forwards a target branch). */
export interface RefMove {
  readonly ref: string;
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly taskId: string;
}

/** A file's (or symlink's) fingerprint; null for directories and missing paths. */
function fingerprint(path: string): string | null {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return null;
  try {
    if (info.isSymbolicLink()) return `symlink → ${readlinkSync(path)}`;
    if (!info.isFile()) return null;
    const executable = (info.mode & 0o111) !== 0 ? " (executable)" : "";
    return `${sha256Of(readFileSync(path))}${executable}`;
  } catch (error) {
    // Unreadable is a state too: a change to or from it is reported.
    return `unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/** The git directory's executable surface (see the module comment). */
export function gitDirSurface(commonDir: string): Map<string, string> {
  const surface = new Map<string, string>();
  const visit = (rel: string): void => {
    if (surface.size >= SURFACE_LIMIT) return;
    const path = join(commonDir, rel);
    const print = fingerprint(path);
    if (print !== null) {
      surface.set(rel, print);
      return;
    }
    for (const name of listDir(path)) visit(join(rel, name));
  };
  for (const rel of SURFACE_ROOTS) visit(rel);
  for (const name of listDir(join(commonDir, "worktrees"))) {
    visit(join("worktrees", name, "config.worktree"));
  }
  return surface;
}

/** Snapshot the refs (with the HEADs of `root` and `worktree`) and the git directory's surface. */
export async function guardSnapshot(
  root: string,
  worktree: string,
  env: Env,
): Promise<GuardSnapshot> {
  const commonDir = await gitCommonDir(root, env);
  const refs = await refSnapshot(root, worktree, env);
  return { refs, gitDir: gitDirSurface(commonDir), commonDir };
}

// ------------------------------------------------- Groot's own ref moves

const journalPath = (root: string): string => join(stateDir(root), "ref-moves.jsonl");

/** Journal a ref move Groot is about to make (before making it — a reader may compare meanwhile). */
export function recordRefMove(root: string, move: Omit<RefMove, "at">): void {
  ensureStateDir(root);
  appendFileSync(journalPath(root), `${JSON.stringify({ ...move, at: nowIso() })}\n`);
}

function asMove(line: string): RefMove | null {
  try {
    const doc = JSON.parse(line) as Partial<RefMove>;
    return typeof doc.ref === "string" && typeof doc.from === "string" && typeof doc.to === "string"
      ? (doc as RefMove)
      : null;
  } catch {
    return null;
  }
}

/** The journaled moves (most recent JOURNAL_LIMIT; unreadable lines skipped). */
export async function readRefMoves(root: string): Promise<RefMove[]> {
  const text = await readFile(journalPath(root), "utf8").catch(() => "");
  return text
    .split("\n")
    .slice(-JOURNAL_LIMIT - 1)
    .map(asMove)
    .filter((move) => move !== null);
}

/** Did Groot's own journaled moves take `ref` from `from` to `to` (one or several fast-forwards)? */
export function movedByGroot(
  moves: readonly RefMove[],
  ref: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from === undefined || to === undefined) return false;
  const next = new Map<string, string[]>();
  for (const move of moves.filter((entry) => entry.ref === ref)) {
    next.set(move.from, [...(next.get(move.from) ?? []), move.to]);
  }
  const queue = [from];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    queue.push(...(next.get(at) ?? []));
  }
  return false;
}

// ------------------------------------------------------------ comparison

function surfaceChanges(root: string, before: GuardSnapshot, after: GuardSnapshot): string[] {
  const names = [...new Set([...before.gitDir.keys(), ...after.gitDir.keys()])].sort();
  const shown = (rel: string): string => {
    const path = join(after.commonDir, rel);
    const local = relative(root, path);
    return local.startsWith("..") ? path : local;
  };
  return names.flatMap((rel) => {
    const was = before.gitDir.get(rel);
    const now = after.gitDir.get(rel);
    if (was === now) return [];
    const what = was === undefined ? "added" : now === undefined ? "removed" : "changed";
    return [`${shown(rel)} ${what}`];
  });
}

/**
 * What changed between two snapshots that must not have (see the module
 * comment); `taskId`'s own branches never may.
 */
export async function guardChanges(
  root: string,
  taskId: string,
  before: GuardSnapshot,
  after: GuardSnapshot,
): Promise<string[]> {
  const own = new Set([
    `refs/heads/${taskBranch(taskId)}`,
    `refs/heads/${integrationBranch(taskId)}`,
  ]);
  const moves = await readRefMoves(root);
  const mayMove = (name: string, from: string | undefined, to: string | undefined): boolean =>
    (name.startsWith("refs/heads/groot/") && !own.has(name)) ||
    name.startsWith("refs/remotes/") ||
    movedByGroot(moves, name, from, to);
  return [...refChanges(before.refs, after.refs, mayMove), ...surfaceChanges(root, before, after)];
}

/** Snapshot again and compare with `before`; an unreadable repository is itself a change. */
export async function guardAfter(
  root: string,
  worktree: string,
  taskId: string,
  before: GuardSnapshot,
  env: Env,
): Promise<string[]> {
  try {
    return await guardChanges(root, taskId, before, await guardSnapshot(root, worktree, env));
  } catch (error) {
    return [
      `(the repository could not be read: ${error instanceof Error ? error.message : String(error)})`,
    ];
  }
}

/** Warn when the main checkout changed in a window (a write outside the worktree, or the user's edit). */
function warnCheckout(
  ctx: CoreContext,
  taskId: string,
  changed: readonly string[],
  during: string,
): void {
  if (changed.length === 0) return;
  ctx.events.emit({
    type: "task.warning",
    level: "warn",
    message: `${taskId}: the main checkout changed while ${during} (a write outside the worktree, or a concurrent edit): ${changed.slice(0, 5).join(", ")}`,
    taskId,
    data: { changed: [...changed] },
  });
}

export interface RepositoryWatch {
  /** What changed so far that must not have (refs, git directory). */
  check(): Promise<string[]>;
  /** The same, after warning about main-checkout changes; call once, when the window closes. */
  finish(): Promise<string[]>;
}

/** Start watching the repository through one window (`during`: "the runner worked", …). */
export async function watchRepository(
  ctx: CoreContext,
  root: string,
  worktree: string,
  taskId: string,
  during: string,
): Promise<RepositoryWatch> {
  const [checkout, before] = await Promise.all([
    statusEntries(root, ctx.env),
    guardSnapshot(root, worktree, ctx.env),
  ]);
  const check = (): Promise<string[]> => guardAfter(root, worktree, taskId, before, ctx.env);
  return {
    check,
    async finish() {
      const [now, changes] = await Promise.all([statusEntries(root, ctx.env), check()]);
      const changed = now.filter((entry) => !checkout.includes(entry));
      warnCheckout(ctx, taskId, changed, during);
      return changes;
    },
  };
}
