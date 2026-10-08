/**
 * Read-only, project-bounded filesystem access for discovery.
 *
 * Every path is realpath'd and must stay inside the (realpath'd) root: a
 * symlink that leaves the project is never followed — it is recorded as a
 * note (surfaced as an observation unknown) instead. Directory walks never
 * descend through symlinks at all, so cycles and double counting are
 * impossible. Generated or vendored trees are skipped everywhere; nothing
 * here executes, imports, or writes anything.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Sha256 } from "../contracts/common.ts";
import { sha256Of } from "../fs/hash.ts";

/** Directory names skipped at every level (dependencies, VCS, build output, local state). */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".groot",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".svelte-kit",
  ".output",
  // Native build output (Rust, CocoaPods, Python virtualenvs) — large and never hand-written.
  "target",
  "Pods",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Project paths skipped in addition: agent worktrees are other checkouts of this repository. */
export const SKIPPED_PATHS: ReadonlySet<string> = new Set([".claude/worktrees"]);

export interface DirEntry {
  readonly name: string;
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly type: "file" | "dir";
  readonly symlink: boolean;
}

export interface TextFile {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: Sha256;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Is `candidate` the root or inside it? (`..foo` siblings are not inside) */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Names that can't be expressed as a contract RelPath segment. */
function unrepresentable(name: string): boolean {
  return name.includes("\\") || name.includes("\0");
}

export function joinProjectPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

export class ProjectFs {
  readonly root: string;
  private readonly notesSet = new Set<string>();

  /** `root` must already be a real (symlink-free) absolute path. */
  constructor(root: string) {
    this.root = root;
  }

  /** What discovery could not see (outside symlinks, unreadable files), sorted. */
  notes(): string[] {
    return [...this.notesSet].sort();
  }

  note(message: string): void {
    this.notesSet.add(message);
  }

  /** Real absolute path for a project path, or null when absent or outside the project. */
  async real(rel: string): Promise<string | null> {
    const absolute = rel === "." ? this.root : join(this.root, rel);
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch {
      return null;
    }
    if (!isInside(this.root, resolved)) {
      this.note(`${rel} is a symlink that resolves outside the project — not followed`);
      return null;
    }
    return resolved;
  }

  async kind(rel: string): Promise<"file" | "dir" | null> {
    const real = await this.real(rel);
    if (real === null) return null;
    try {
      const info = await stat(real);
      if (info.isFile()) return "file";
      return info.isDirectory() ? "dir" : null;
    } catch {
      return null;
    }
  }

  async isFile(rel: string): Promise<boolean> {
    return (await this.kind(rel)) === "file";
  }

  async isDir(rel: string): Promise<boolean> {
    return (await this.kind(rel)) === "dir";
  }

  /** Whether any of `names` exists as a file directly inside `dir`. */
  async anyFile(dir: string, names: readonly string[]): Promise<boolean> {
    for (const name of names) {
      if (await this.isFile(joinProjectPath(dir, name))) return true;
    }
    return false;
  }

  /** UTF-8 text plus byte length and hash; null when absent, outside, too large, or unreadable. */
  async readText(rel: string, maxBytes = DEFAULT_MAX_BYTES): Promise<TextFile | null> {
    const real = await this.real(rel);
    if (real === null) return null;
    try {
      const info = await stat(real);
      if (!info.isFile()) return null;
      if (info.size > maxBytes) {
        this.note(`${rel} is larger than ${maxBytes} bytes — not read`);
        return null;
      }
      const buffer = await readFile(real);
      return { text: buffer.toString("utf8"), bytes: buffer.byteLength, sha256: sha256Of(buffer) };
    } catch {
      this.note(`${rel} could not be read`);
      return null;
    }
  }

  /** Hash of a file's bytes without size limits (lockfiles), or null. */
  async hash(rel: string): Promise<Sha256 | null> {
    const real = await this.real(rel);
    if (real === null) return null;
    try {
      return sha256Of(await readFile(real));
    } catch {
      return null;
    }
  }

  /**
   * Entries of a project directory, sorted by name, without skipped
   * directories. Symlinks inside the project are listed (marked) so callers
   * can decide whether to use them; walks must not descend through them.
   */
  async list(dir: string): Promise<DirEntry[]> {
    const real = await this.real(dir);
    if (real === null) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const listed: DirEntry[] = [];
    for (const entry of entries) {
      const path = joinProjectPath(dir, entry.name);
      if (unrepresentable(entry.name)) {
        this.note(`${dir}: an entry with a backslash or NUL in its name was skipped`);
        continue;
      }
      const resolved = await this.entryType(entry, path);
      if (resolved === null) continue;
      if (resolved.type === "dir" && (SKIPPED_DIRS.has(entry.name) || SKIPPED_PATHS.has(path))) {
        continue;
      }
      listed.push({ name: entry.name, path, ...resolved });
    }
    return listed;
  }

  private async entryType(
    entry: Dirent,
    path: string,
  ): Promise<{ type: "file" | "dir"; symlink: boolean } | null> {
    if (entry.isDirectory()) return { type: "dir", symlink: false };
    if (entry.isFile()) return { type: "file", symlink: false };
    if (!entry.isSymbolicLink()) return null;
    const type = await this.kind(path);
    return type === null ? null : { type, symlink: true };
  }

  /**
   * Breadth-first walk of real directories (symlinked directories are never
   * entered). Hidden directories are skipped below the root when
   * `skipHidden` is set. Stops — with a note — at `maxDirs`.
   */
  async walk(options: {
    readonly maxDepth: number;
    readonly maxDirs: number;
    readonly skipHidden: boolean;
    readonly visit: (dir: string, entries: readonly DirEntry[]) => void;
  }): Promise<void> {
    let frontier: string[] = ["."];
    let visited = 0;
    for (let depth = 0; depth <= options.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of frontier) {
        if (visited >= options.maxDirs) {
          this.note(`file search stopped after ${options.maxDirs} directories`);
          return;
        }
        visited++;
        const entries = await this.list(dir);
        options.visit(dir, entries);
        for (const entry of entries) {
          if (entry.type !== "dir" || entry.symlink) continue;
          if (options.skipHidden && entry.name.startsWith(".")) continue;
          next.push(entry.path);
        }
      }
      frontier = next;
    }
  }
}
