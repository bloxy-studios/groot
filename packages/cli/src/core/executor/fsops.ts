/**
 * Filesystem primitives of the executor: hashing tracked keys, backing up
 * bytes before an effect, restoring them on rollback, and creating
 * directories while remembering which ones a step created.
 *
 * Tracked keys: a plain project-relative path is a file (its sha256, null when
 * absent); `tree:<path>` is a directory tree (core/fs/hash.ts hashTree — used
 * for generator output and recursive deletes). Backups live under the
 * operation's `backups/<stepId>/…`, keep the original file mode, and are
 * concealed (core/executor/secrets.ts) so no generated secret is copied.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Sha256 } from "../contracts/common.ts";
import type { PathHashes } from "../contracts/operation.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { hashFile, hashTree, sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { prettyJson } from "../json.ts";
import { STATE_DIR_NAME } from "../state.ts";
import type { OperationPaths } from "./journal.ts";
import type { Placeholder, SecretBook } from "./secrets.ts";

export const TREE_PREFIX = "tree:";

/**
 * hashTree of a directory without content (hashTree joins no entries). A tree
 * key going back to this hash is restored by emptying the directory — no
 * backup needed, which matters for generators producing into an existing
 * empty directory or the project root.
 */
export const EMPTY_TREE_HASH: Sha256 = sha256Of("");

export function treeKey(path: string): string {
  return `${TREE_PREFIX}${path}`;
}

export interface TrackedKey {
  readonly kind: "file" | "tree";
  readonly path: string;
}

export function parseKey(key: string): TrackedKey {
  return key.startsWith(TREE_PREFIX)
    ? { kind: "tree", path: key.slice(TREE_PREFIX.length) }
    : { kind: "file", path: key };
}

/** What is at a path right now (symlinks are reported as "other", never followed). */
export function pathKind(abs: string): "absent" | "file" | "dir" | "other" {
  try {
    const info = lstatSync(abs);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch {
    return "absent";
  }
}

/** Current hash of a tracked key (null = absent). A directory where a file is tracked hashes as a marker. */
export async function currentHash(root: string, key: string): Promise<Sha256 | null> {
  const parsed = parseKey(key);
  const abs = resolveInProject(root, parsed.path);
  if (parsed.kind === "tree") return hashTree(abs);
  const kind = pathKind(abs);
  if (kind === "absent") return null;
  if (kind !== "file") return sha256Of(`groot:not-a-file:${kind}`);
  return hashFile(abs);
}

export async function hashKeys(root: string, keys: readonly string[]): Promise<PathHashes> {
  const out: PathHashes = {};
  for (const key of keys) out[key] = await currentHash(root, key);
  return out;
}

/** Directory (posix, project-relative) that would contain `relPath` ("." for top-level files). */
function parentRel(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "." : relPath.slice(0, index);
}

/**
 * Create the parent directories of `relPath`; returns the ones created
 * (outermost first) so rollback can remove them again when empty.
 */
export function ensureParentDirs(root: string, relPath: string): string[] {
  const missing: string[] = [];
  let dir = parentRel(relPath);
  while (dir !== "." && pathKind(resolveInProject(root, dir)) === "absent") {
    missing.unshift(dir);
    dir = parentRel(dir);
  }
  if (missing.length > 0)
    mkdirSync(resolveInProject(root, parentRel(relPath)), { recursive: true });
  return missing;
}

/** Remove directories a step created, deepest first, only while they are empty. */
export function removeCreatedDirs(root: string, dirs: readonly string[]): void {
  const sorted = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of sorted) {
    const abs = resolveInProject(root, dir);
    if (pathKind(abs) !== "dir") continue;
    if (readdirSync(abs).length > 0) continue;
    rmdirSync(abs);
  }
}

/** Mode bits of a file (permissions only). */
export function fileMode(abs: string): number {
  return statSync(abs).mode & 0o777;
}

function sidecarPath(paths: OperationPaths, stepId: string): string {
  return join(paths.backups, `${stepId}.secrets.json`);
}

function readSidecar(paths: OperationPaths, stepId: string): Record<string, Placeholder[]> {
  try {
    return JSON.parse(readFileSync(sidecarPath(paths, stepId), "utf8")) as Record<
      string,
      Placeholder[]
    >;
  } catch {
    return {};
  }
}

/**
 * Back up the current bytes of tracked keys that exist. Returns the journal's
 * `backups` map (key → path relative to the operation directory).
 */
export function backupKeys(
  root: string,
  paths: OperationPaths,
  stepId: string,
  keys: readonly string[],
  secrets: SecretBook,
): Record<string, string> {
  const backups: Record<string, string> = {};
  const concealed: Record<string, Placeholder[]> = {};
  for (const key of keys) {
    const parsed = parseKey(key);
    const abs = resolveInProject(root, parsed.path);
    const rel = `backups/${stepId}/${parsed.path}`;
    const target = join(paths.dir, rel);
    const kind = pathKind(abs);
    if (parsed.kind === "tree") {
      // An absent or content-free tree is restored without a backup (EMPTY_TREE_HASH).
      if (kind !== "dir" || contentEntries(abs).length === 0) continue;
      rmSync(target, { recursive: true, force: true });
      cpSync(abs, target, { recursive: true, verbatimSymlinks: true, filter: notStateDir(root) });
    } else {
      if (kind !== "file") continue;
      const { bytes, placeholders } = secrets.conceal(readFileSync(abs));
      writeFileAtomic(target, bytes, fileMode(abs));
      chmodSync(target, fileMode(abs));
      if (placeholders.length > 0) concealed[parsed.path] = placeholders;
    }
    backups[key] = rel;
  }
  if (Object.keys(concealed).length > 0) {
    writeFileAtomic(sidecarPath(paths, stepId), prettyJson(concealed), 0o600);
  }
  return backups;
}

/**
 * The exact original bytes of a file backup (placeholders revealed), or null
 * when they cannot be reproduced or do not match the journaled hash.
 */
export function backupBytes(
  paths: OperationPaths,
  stepId: string,
  backupRel: string,
  filePath: string,
  expected: Sha256,
  secrets: SecretBook,
): Uint8Array | null {
  const abs = join(paths.dir, backupRel);
  if (pathKind(abs) !== "file") return null;
  const placeholders = readSidecar(paths, stepId)[filePath] ?? [];
  const bytes = secrets.reveal(readFileSync(abs), placeholders);
  if (bytes === null || sha256Of(bytes) !== expected) return null;
  return bytes;
}

/** Write restored bytes over `relPath` atomically with the backup's file mode. */
export function restoreFile(
  root: string,
  relPath: string,
  bytes: Uint8Array,
  backupAbs: string,
): void {
  const abs = resolveInProject(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  const mode = existsSync(backupAbs) ? fileMode(backupAbs) : 0o644;
  writeFileAtomic(abs, bytes, mode);
  chmodSync(abs, mode);
}

/** Entries of a directory that count as content — Groot's own `.groot/` never does. */
export function contentEntries(abs: string): string[] {
  return readdirSync(abs).filter((entry) => entry !== STATE_DIR_NAME);
}

/** cpSync filter that never copies the project's `.groot/` (a backup must not contain itself). */
function notStateDir(root: string): (source: string) => boolean {
  const state = join(resolve(root), STATE_DIR_NAME);
  return (source) => source !== state && !source.startsWith(`${state}${sep}`);
}

/** Remove a file or directory tree inside the project — never the project root itself. */
export function removePath(root: string, relPath: string): void {
  const abs = resolveInProject(root, relPath);
  if (abs === resolve(root)) {
    throw new GrootV2Error("GROOT_E_INTERNAL", "Refusing to remove the project root.", {
      details: { path: relPath },
    });
  }
  rmSync(abs, { recursive: true, force: true });
}
