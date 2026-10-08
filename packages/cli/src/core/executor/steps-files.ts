/**
 * File-level step effects: write, structured edit, delete, move, dependency
 * merge, and local secret generation. Each assumes the runner already
 * re-verified the step's expectation and journaled its intent (with
 * backups), and returns the after-hashes of the keys it tracks.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync } from "node:fs";
import type {
  DependencyChange,
  DepsAction,
  FileDeleteAction,
  FileEditAction,
  FileMoveAction,
  FileWriteAction,
  SecretAction,
  StructuredEdit,
} from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { addEnvEntries, applyEdit, TransformConflict } from "../transforms/index.ts";
import { ensureParentDirs, fileMode, pathKind, treeKey } from "./fsops.ts";
import { hasEnvAssignment } from "./secrets.ts";
import type { StepContext, StepEffect } from "./step-context.ts";

/** Entropy of generated local secrets (32 bytes → 43 base64url characters). */
const SECRET_BYTES = 32;

/** Mode for files holding generated secrets. */
const SECRET_MODE = 0o600;

const DEFAULT_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

function readTextIfFile(abs: string): string | null {
  return pathKind(abs) === "file" ? readFileSync(abs, "utf8") : null;
}

/** Atomic write that keeps an existing file's mode (or uses `mode` for new files). */
function writeKeepingMode(abs: string, content: string, mode?: number): void {
  const effective = mode ?? (pathKind(abs) === "file" ? fileMode(abs) : DEFAULT_MODE);
  writeFileAtomic(abs, content, effective);
  chmodSync(abs, effective);
}

function conflict(
  path: string,
  message: string,
  extra: Record<string, unknown> = {},
): GrootV2Error {
  return new GrootV2Error("GROOT_E_CONFLICT", message, {
    hint: "Resolve the file by hand (or restore it), then `groot resume`; nothing else was overwritten.",
    details: { path, ...extra },
  });
}

/** Apply a structured edit, turning a TransformConflict into GROOT_E_CONFLICT. */
export function applyEditOrConflict(
  current: string | null,
  edit: StructuredEdit,
  path: string,
): string {
  try {
    return applyEdit(current, edit, path);
  } catch (error) {
    if (error instanceof TransformConflict) {
      throw conflict(path, error.message, { conflict: "transform", reason: error.reason });
    }
    throw error;
  }
}

export function packageJsonPath(unit: string): string {
  return unit === "." ? "package.json" : `${unit}/package.json`;
}

/**
 * Merge exact dependency versions into package.json text. Formatting is
 * preserved by the JSON transform; a section that was alphabetically sorted
 * (what `bun add` maintains) stays sorted.
 */
export function mergeDependencies(
  current: string,
  changes: readonly DependencyChange[],
  path: string,
): string {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(current) as Record<string, unknown>;
  } catch (error) {
    throw conflict(path, `${path}: cannot parse as JSON (${String(error)})`);
  }
  const ops = (["dependencies", "devDependencies"] as const).flatMap((section) => {
    const wanted = changes.filter((change) => change.dev === (section === "devDependencies"));
    if (wanted.length === 0) return [];
    const existing = document[section];
    const base =
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    const keys = Object.keys(base);
    const wasSorted = keys.every((key, index) => index === 0 || (keys[index - 1] ?? "") <= key);
    const merged: Record<string, unknown> = { ...base };
    for (const change of wanted) merged[change.package] = change.to;
    const value = wasSorted
      ? Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : merged;
    return [{ op: "set" as const, pointer: `/${section}`, value }];
  });
  return applyEditOrConflict(current, { kind: "json", ops }, path);
}

function unchanged(path: string, content: string): StepEffect {
  return {
    outcome: "already-applied",
    after: { [path]: sha256Of(content) },
    created: [],
    logRef: null,
  };
}

export function writeStep(sc: StepContext, action: FileWriteAction): StepEffect {
  const abs = resolveInProject(sc.root, action.path);
  const created = ensureParentDirs(sc.root, action.path);
  const mode = action.executable ? EXECUTABLE_MODE : undefined;
  writeKeepingMode(abs, action.content, mode);
  return { outcome: "applied", after: { [action.path]: action.sha256 }, created, logRef: null };
}

export function editStep(sc: StepContext, action: FileEditAction): StepEffect {
  const abs = resolveInProject(sc.root, action.path);
  const current = readTextIfFile(abs);
  if (current === null && !action.createIfMissing) {
    throw conflict(
      action.path,
      `${action.path} does not exist, so the edit has nothing to apply to.`,
      {
        conflict: "missing-file",
      },
    );
  }
  // Precomputed edits carry their exact result (the expectation was verified);
  // deferred edits are computed now against the file an earlier step produced.
  const next =
    action.after !== null
      ? action.after.content
      : applyEditOrConflict(current, action.edit, action.path);
  if (current !== null && next === current) return unchanged(action.path, current);
  const created = current === null ? ensureParentDirs(sc.root, action.path) : [];
  writeKeepingMode(abs, next);
  return { outcome: "applied", after: { [action.path]: sha256Of(next) }, created, logRef: null };
}

export function deleteStep(sc: StepContext, action: FileDeleteAction): StepEffect {
  const abs = resolveInProject(sc.root, action.path);
  const kind = pathKind(abs);
  if (kind === "absent") {
    return {
      outcome: "already-applied",
      after: { [action.path]: null },
      created: [],
      logRef: null,
    };
  }
  if (kind === "dir") {
    // Directory trees are only deleted when this operation produced them.
    if (!action.recursive || action.expect.state !== "produced") {
      throw conflict(
        action.path,
        `${action.path} is a directory; Groot only deletes directory trees produced earlier in the same operation.`,
        { conflict: "directory" },
      );
    }
    rmSync(abs, { recursive: true, force: true });
    return {
      outcome: "applied",
      after: { [treeKey(action.path)]: null },
      created: [],
      logRef: null,
    };
  }
  rmSync(abs, { force: true });
  return { outcome: "applied", after: { [action.path]: null }, created: [], logRef: null };
}

export function moveStep(sc: StepContext, action: FileMoveAction): StepEffect {
  const from = resolveInProject(sc.root, action.from);
  const to = resolveInProject(sc.root, action.to);
  if (pathKind(from) !== "file") {
    throw conflict(action.from, `${action.from} is not a file; file.move moves single files.`, {
      conflict: "move-source",
    });
  }
  if (pathKind(to) !== "absent") {
    throw conflict(action.to, `${action.to} already exists; moving onto it would overwrite it.`, {
      conflict: "move-target",
    });
  }
  const hash = sha256Of(readFileSync(from));
  const created = ensureParentDirs(sc.root, action.to);
  renameSync(from, to);
  return {
    outcome: "applied",
    after: { [action.from]: null, [action.to]: hash },
    created,
    logRef: null,
  };
}

export function depsStep(sc: StepContext, action: DepsAction): StepEffect {
  const path = packageJsonPath(action.unit);
  const abs = resolveInProject(sc.root, path);
  const current = readTextIfFile(abs);
  if (current === null) {
    throw conflict(path, `${path} does not exist; dependencies can only be added to a package.`, {
      conflict: "missing-file",
    });
  }
  const next = mergeDependencies(current, action.changes, path);
  if (next === current) return unchanged(path, current);
  writeKeepingMode(abs, next);
  return { outcome: "applied", after: { [path]: sha256Of(next) }, created: [], logRef: null };
}

/**
 * Generate a local development secret into a gitignored env file. The value
 * exists only in that file (mode 0600): it is never returned, journaled,
 * logged, or emitted — the journal records the file's hash only.
 */
export function secretStep(sc: StepContext, action: SecretAction): StepEffect {
  const abs = resolveInProject(sc.root, action.path);
  const current = readTextIfFile(abs);
  if (current !== null && hasEnvAssignment(current, action.name)) {
    return unchanged(action.path, current);
  }
  const value = randomBytes(SECRET_BYTES).toString("base64url");
  sc.secrets.remember(value, { name: action.name, path: action.path });
  const next = addEnvEntries(current, [{ name: action.name, value, comment: null }]);
  const created = current === null ? ensureParentDirs(sc.root, action.path) : [];
  writeFileAtomic(abs, next, SECRET_MODE);
  chmodSync(abs, SECRET_MODE);
  return { outcome: "applied", after: { [action.path]: sha256Of(next) }, created, logRef: null };
}
