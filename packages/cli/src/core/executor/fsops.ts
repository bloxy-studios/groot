/**
 * Filesystem primitives of the executor: hashing tracked keys, backing up
 * bytes before an effect, restoring them on rollback, creating directories
 * while remembering which ones a step created, and removing paths — never a
 * `.git` or `.groot`, nor a tree that holds one.
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
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Sha256 } from "../contracts/common.ts";
import type { PathHashes } from "../contracts/operation.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { hashFile, hashTree, sha256Of } from "../fs/hash.ts";
import { joinRel, resolveInProject } from "../fs/paths.ts";
import { prettyJson } from "../json.ts";
import { STATE_DIR_NAME } from "../state.ts";
import { type OperationPaths, operationFile } from "./journal.ts";
import { reservedName } from "./reserved.ts";
import type { Placeholder, SecretBook, SecretRef } from "./secrets.ts";

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

/** Per-step records kept next to a step's backups. */
type StepRecordKind = "secrets" | "modes" | "dirs" | "generator";

const STEP_RECORD_KINDS: readonly StepRecordKind[] = ["secrets", "modes", "dirs", "generator"];

/** Backups are owner-only; the mode a file had is recorded and restored separately. */
const BACKUP_MODE = 0o600;

/**
 * `backups/<stepId>.<kind>.json` (mode 0600): the placeholders of concealed
 * secrets, original file modes, directories absent at intent, a generator's
 * result. Written at intent (a generator's during its effect).
 */
export function stepRecordPath(
  paths: OperationPaths,
  stepId: string,
  kind: StepRecordKind,
): string {
  return join(paths.backups, `${stepId}.${kind}.json`);
}

export function writeStepRecord(
  paths: OperationPaths,
  stepId: string,
  kind: StepRecordKind,
  value: unknown,
): void {
  writeFileAtomic(stepRecordPath(paths, stepId, kind), prettyJson(value), BACKUP_MODE);
}

/** A step record's parsed JSON, or null when absent or unreadable. */
export function readStepRecord(
  paths: OperationPaths,
  stepId: string,
  kind: StepRecordKind,
): unknown {
  try {
    return JSON.parse(readFileSync(stepRecordPath(paths, stepId, kind), "utf8"));
  } catch {
    return null;
  }
}

/** The placeholders concealed in a step's backup of `filePath` (its `secrets` record). */
function backupPlaceholders(
  paths: OperationPaths,
  stepId: string,
  filePath: string,
): Placeholder[] {
  const record = readStepRecord(paths, stepId, "secrets");
  if (typeof record !== "object" || record === null || !Object.hasOwn(record, filePath)) return [];
  const placeholders = (record as Record<string, unknown>)[filePath];
  return Array.isArray(placeholders) ? (placeholders as Placeholder[]) : [];
}

/** The secret variables (name + env file) a step's backup of `filePath` conceals. */
export function concealedIn(paths: OperationPaths, stepId: string, filePath: string): SecretRef[] {
  const unique = new Map<string, SecretRef>();
  for (const { name, path } of backupPlaceholders(paths, stepId, filePath)) {
    unique.set(`${path}\0${name}`, { name: String(name), path: String(path) });
  }
  return [...unique.values()];
}

/**
 * Back up the current bytes of tracked keys that exist (files 0600, their
 * modes recorded). Returns the journal's `backups` map (key → path relative
 * to the operation directory).
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
  const modes: Record<string, number> = {};
  // A step without a journaled intent has no backups yet: anything here is a
  // leftover of a crash before the intent (or planted), never written through.
  rmSync(join(paths.backups, stepId), { recursive: true, force: true });
  for (const kind of STEP_RECORD_KINDS)
    rmSync(stepRecordPath(paths, stepId, kind), { force: true });
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
      writeFileAtomic(target, bytes, BACKUP_MODE);
      modes[parsed.path] = fileMode(abs);
      if (placeholders.length > 0) concealed[parsed.path] = placeholders;
    }
    backups[key] = rel;
  }
  if (Object.keys(concealed).length > 0) writeStepRecord(paths, stepId, "secrets", concealed);
  if (Object.keys(modes).length > 0) writeStepRecord(paths, stepId, "modes", modes);
  return backups;
}

/** The mode a backed-up file had (recorded at intent; older backups kept it on the copy). */
export function backupMode(
  paths: OperationPaths,
  stepId: string,
  filePath: string,
  backupAbs: string,
): number {
  const recorded = (readStepRecord(paths, stepId, "modes") as Record<string, unknown> | null)?.[
    filePath
  ];
  if (typeof recorded === "number" && Number.isInteger(recorded)) return recorded & 0o777;
  return existsSync(backupAbs) ? fileMode(backupAbs) : 0o644;
}

/**
 * Ancestor directories of the keys' paths that do not exist yet — the ones
 * the step may create. Recorded at intent so a step that never journals its
 * completion (in flight, reconciled, skipped) still has them removed by
 * rollback when they end up empty.
 */
export function absentAncestors(root: string, keys: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const key of keys) {
    let dir = parentRel(parseKey(key).path);
    while (dir !== "." && pathKind(resolveInProject(root, dir)) === "absent") {
      missing.add(dir);
      dir = parentRel(dir);
    }
  }
  return [...missing].sort((a, b) => a.split("/").length - b.split("/").length);
}

/** Directories recorded as absent at the step's intent (see absentAncestors). */
export function absentAtIntent(paths: OperationPaths, stepId: string): string[] {
  const recorded = readStepRecord(paths, stepId, "dirs");
  return Array.isArray(recorded)
    ? recorded.filter((dir): dir is string => typeof dir === "string" && reservedName(dir) === null)
    : [];
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
  const abs = operationFile(paths, backupRel);
  if (pathKind(abs) !== "file") return null;
  const placeholders = backupPlaceholders(paths, stepId, filePath);
  const bytes = secrets.reveal(readFileSync(abs), placeholders);
  if (bytes === null || sha256Of(bytes) !== expected) return null;
  return bytes;
}

/** Write restored bytes over `relPath` atomically with the file's original mode. */
export function restoreFile(root: string, relPath: string, bytes: Uint8Array, mode: number): void {
  const abs = resolveInProject(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
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

/**
 * `.git` and `.groot` entries (any spelling reserved.ts knows — directories,
 * gitlink files, links) that removing the tree at `relPath` would take with
 * it, as project-relative paths. The project root keeps its own, so for "."
 * only nested ones count. Tree hashes ignore these names at every level, so a
 * tree that hashes as Groot left it can still hold a repository a human
 * created inside it. node_modules is not searched.
 */
export function reservedWithin(root: string, relPath: string): string[] {
  const abs = removalTarget(root, relPath);
  if (pathKind(abs) !== "dir") return []; // a file, or a link (removing it leaves its target)
  const found: string[] = [];
  const walk = (abs: string, rel: string, top: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // gone, or not a directory: nothing inside it
    }
    for (const entry of entries) {
      const child = joinRel(rel, entry.name);
      if (reservedName(entry.name) !== null) {
        if (!top) found.push(child);
      } else if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(join(abs, entry.name), child, false);
      }
    }
  };
  walk(abs, relPath, abs === resolve(root));
  return found.sort();
}

/**
 * Where removing `relPath` acts: its parent resolved inside the project, then
 * the entry itself, unresolved — removing a link removes the link, never what
 * it points to (which may lie outside the project).
 */
function removalTarget(root: string, relPath: string): string {
  if (relPath === ".") return resolve(root);
  return join(resolveInProject(root, parentRel(relPath)), basename(relPath));
}

/** GROOT_E_CONFLICT: removing `relPath` would delete the `.git`/`.groot` entries inside it. */
export function refusedRemoval(
  relPath: string,
  reserved: readonly string[],
  stepId?: string,
): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_CONFLICT",
    `Refusing to remove ${relPath}: it holds ${reserved.join(", ")}, and Groot never deletes a .git or .groot directory.`,
    {
      hint: `Move ${reserved.join(", ")} out of ${relPath} first.`,
      details: {
        path: relPath,
        paths: [...reserved],
        conflict: "reserved",
        ...(stepId === undefined ? {} : { stepId }),
      },
    },
  );
}

/**
 * Remove a file or directory tree inside the project — never the project
 * root, and never a `.git` or `.groot` (nor a tree holding one: callers
 * decide about those first, this is the backstop).
 */
export function removePath(root: string, relPath: string): void {
  const abs = removalTarget(root, relPath);
  if (abs === resolve(root) || reservedName(relPath) !== null) {
    throw new GrootV2Error("GROOT_E_INTERNAL", `Refusing to remove ${relPath}.`, {
      details: { path: relPath },
    });
  }
  const reserved = reservedWithin(root, relPath);
  if (reserved.length > 0) throw refusedRemoval(relPath, reserved);
  rmSync(abs, { recursive: true, force: true });
}
