/**
 * Directories no plan action may target: Groot's own state (`.groot/` — every
 * operation's journal and backups) and git's `.git/` (the user's history, and
 * hooks or config that would run code on the next git command). A plan file
 * is untrusted, so this holds for every path an action names, not only for
 * deletes.
 *
 * Names are compared the way filesystems resolve them, as git does for
 * `.git`: case-insensitively (macOS, Windows), ignoring trailing dots and
 * spaces and `:stream` suffixes (NTFS), 8.3 short names (`GIT~1`), and code
 * points HFS+ ignores. Plan validation checks the document's paths; right
 * before a step runs its paths are checked again at their real location, so
 * a symlink inside the project cannot route a write into `.groot/`.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { resolveInProject } from "../fs/paths.ts";
import { namedPaths } from "./action-paths.ts";

export type ReservedDir = ".groot" | ".git";

/** Code points HFS+ ignores in file names (git's is_hfs_dotgit list). */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/** A path segment as the filesystem would match it. */
function canonicalSegment(segment: string): string {
  const name = segment.replace(HFS_IGNORABLE, "").toLowerCase();
  const stream = name.indexOf(":");
  return (stream === -1 ? name : name.slice(0, stream)).replace(/[. ]+$/, "");
}

/** The reserved directory a path names or lies inside (any segment), if any. */
export function reservedName(path: string): ReservedDir | null {
  for (const segment of path.split(/[\\/]/)) {
    const name = canonicalSegment(segment);
    if (name === ".groot" || /^groot~\d+$/.test(name)) return ".groot";
    if (name === ".git" || /^git~\d+$/.test(name)) return ".git";
  }
  return null;
}

/** Where a project path really lands: the deepest existing entry's realpath plus the rest. */
function realRelative(root: string, relPath: string): string {
  const realRoot = realpathSync(root);
  let current = resolveInProject(root, relPath);
  const tail: string[] = [];
  for (;;) {
    try {
      return relative(realRoot, join(realpathSync(current), ...tail));
    } catch {
      // absent (or a dangling link, which a write replaces): judge by the parent
    }
    const parent = dirname(current);
    if (parent === current) return relPath;
    tail.unshift(basename(current));
    current = parent;
  }
}

export function describeReserved(reserved: ReservedDir): string {
  return reserved === ".groot"
    ? "Groot's own state directory (.groot)"
    : "git's repository directory (.git)";
}

/**
 * Refuse a step whose paths are, or really resolve into, `.groot/` or `.git/`
 * (GROOT_E_PATH_OUTSIDE_PROJECT) — checked right before its effect.
 */
export function assertNotReserved(root: string, action: PlannedAction): void {
  for (const { path } of namedPaths(action)) {
    const reserved = reservedName(path) ?? reservedName(realRelative(root, path));
    if (reserved === null) continue;
    throw new GrootV2Error(
      "GROOT_E_PATH_OUTSIDE_PROJECT",
      `Step ${action.id} targets ${path}, which is inside ${describeReserved(reserved)}; Groot never changes it from a plan.`,
      {
        hint: "Remove the symlink (or the step) that points there, then re-plan.",
        details: { stepId: action.id, path, reserved },
      },
    );
  }
}
