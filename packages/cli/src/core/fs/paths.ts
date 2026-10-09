/**
 * Project boundary enforcement. Every write Groot performs resolves through
 * `resolveInProject`, which rejects absolute paths, `..` escapes, and symlinks
 * whose real target lies outside the project root. The deepest existing entry
 * (found with lstat, so a dangling link counts as existing) is resolved, and a
 * link whose target does not exist yet is followed by reading it — a
 * not-yet-created file is judged by where a write would actually land. Link
 * text is followed the way the kernel follows it: each `..` steps up from the
 * real directory reached so far, never lexically back through a symlink.
 */
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { GrootV2Error } from "../errors.ts";

/** Symlinks followed by hand per resolution before giving up (Linux's MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

/** Separators in link text: Windows accepts both. */
const LINK_TEXT_SEPARATOR = process.platform === "win32" ? /[\\/]/ : /\//;

/** Normalize an OS path fragment to the contracts' POSIX form. */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined; // absent (ENOENT/ENOTDIR) or unreadable: judged by its parent
  }
}

/** Dangling links followed so far in one resolution, across every branch of it. */
interface HopBudget {
  hops: number;
}

/**
 * The real location of an existing entry that is not a symlink. Bun's
 * realpath can fail with EACCES on an entry it may not read (a chmod 000
 * file on macOS) although its location is known: it is the entry's name in
 * its real parent directory.
 */
function realLocation(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realLocation(parent), basename(path));
  }
}

/**
 * The real location `abs` (an absolute path without `.`/`..` segments)
 * refers to, or null when symlinks loop (or chain past MAX_SYMLINK_HOPS). A
 * dangling link is followed by its link text, relative to the link's own
 * directory.
 */
function realTargetOf(abs: string, budget: HopBudget = { hops: 0 }): string | null {
  let current = abs;
  const tail: string[] = [];
  let entry = lstatOrUndefined(current);
  while (entry === undefined) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
    entry = lstatOrUndefined(current);
  }
  if (entry?.isSymbolicLink()) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      // Dangling (or looping): follow the link text to where a write would land.
      budget.hops += 1;
      if (budget.hops > MAX_SYMLINK_HOPS) return null;
      const target = followLinkText(realpathSync(dirname(current)), readlinkSync(current), budget);
      return target === null ? null : realTargetOf(join(target, ...tail), budget);
    }
  }
  return join(realLocation(current), ...tail);
}

/**
 * Where link text leads from the link's real directory. Segments are taken
 * one at a time: before each `..`, the path so far is resolved to its real
 * location, so `deep/../x` with `deep` → `/elsewhere/a/b` leads to
 * `/elsewhere/a/x`, not to `x` beside the link. Below a missing directory `..`
 * is plain (a writer creating it makes a real directory).
 */
function followLinkText(linkDir: string, text: string, budget: HopBudget): string | null {
  const textRoot = isAbsolute(text) ? parse(text).root : "";
  let base = textRoot === "" ? linkDir : textRoot;
  let pending: string[] = [];
  for (const segment of text.slice(textRoot.length).split(LINK_TEXT_SEPARATOR)) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      pending.push(segment);
      continue;
    }
    const reached = realTargetOf(join(base, ...pending), budget);
    if (reached === null) return null;
    base = dirname(reached);
    pending = [];
  }
  return join(base, ...pending);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a project-relative path to an absolute one, refusing anything that
 * would land outside `root` — lexically or through a symlink.
 */
export function resolveInProject(root: string, relPath: string): string {
  if (relPath.length === 0 || relPath.includes("\0") || relPath.includes("\\")) {
    throw outside(relPath, "empty or malformed path");
  }
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw outside(relPath, "absolute paths are not allowed");
  }
  const lexical = resolve(root, relPath);
  if (!isWithin(resolve(root), lexical)) {
    throw outside(relPath, "the path escapes the project root");
  }
  const realRoot = realpathSync(root);
  const realTarget = realTargetOf(lexical);
  if (realTarget === null) {
    throw outside(relPath, "a symlink on the path loops or chains too deep to resolve");
  }
  if (!isWithin(realRoot, realTarget)) {
    throw outside(relPath, "a symlink resolves outside the project root");
  }
  return lexical;
}

/** Project-relative POSIX path for an absolute path inside root ("." for root). */
export function toProjectPath(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw outside(abs, "the path is outside the project root");
  }
  return toPosix(rel);
}

/** Join project-relative POSIX segments (unit "." + "src/index.ts" → "src/index.ts"). */
export function joinRel(...parts: string[]): string {
  const segments = parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

function outside(path: string, reason: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_PATH_OUTSIDE_PROJECT", `Refusing path "${path}": ${reason}.`, {
    hint: "Groot only writes inside the project root it is operating on.",
    details: { path, reason },
  });
}
