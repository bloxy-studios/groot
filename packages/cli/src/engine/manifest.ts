/**
 * groot.json manifest I/O — the workspace memory written by `init`, consumed and
 * updated by `add`, and read by `doctor` (docs/cli-spec.md#grootjson-manifest).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { findChoice } from "./matrix.ts";
import { MANIFEST_VERSION, type Manifest, type PlannedScaffold, type Slot } from "./types.ts";

const SLOTS: readonly Slot[] = ["web", "mobile", "api", "backend"];

export interface LoadedManifest {
  readonly manifest: Manifest;
  /** Absolute path of groot.json. */
  readonly path: string;
  /** Absolute path of the workspace root (the directory containing groot.json). */
  readonly workspaceRoot: string;
}

/** Walk up from `startDir` to the filesystem root looking for a groot.json. */
export function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, "groot.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function invalid(detail: string, path: string): GrootError {
  return new GrootError(
    `${path} is not a valid groot manifest: ${detail}`,
    EXIT.USAGE,
    [
      "The manifest is written by `groot init` and updated by `groot add`.",
      "If you edited it by hand, compare against the schema:",
      "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json",
    ].join("\n"),
  );
}

/** Structural validation mirroring schemas/groot.schema.json. */
export function validateManifest(value: unknown, path: string): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("expected a JSON object", path);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) {
    throw invalid(
      `unsupported manifest version ${JSON.stringify(record.version)} (this CLI supports version ${MANIFEST_VERSION})`,
      path,
    );
  }
  if (typeof record.createdWith !== "string" || !record.createdWith.startsWith("create-groot@")) {
    throw invalid("missing or malformed createdWith", path);
  }
  const conventions = record.conventions;
  if (
    typeof conventions !== "object" ||
    conventions === null ||
    Array.isArray(conventions) ||
    typeof (conventions as Record<string, unknown>).packagesNamespace !== "string"
  ) {
    throw invalid("missing conventions.packagesNamespace", path);
  }
  if (!Array.isArray(record.scaffolds)) {
    throw invalid("scaffolds must be an array", path);
  }
  for (const entry of record.scaffolds) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalid(`malformed scaffold entry: ${JSON.stringify(entry)}`, path);
    }
    const scaffold = entry as Partial<PlannedScaffold>;
    if (
      scaffold.slot === undefined ||
      !SLOTS.includes(scaffold.slot) ||
      typeof scaffold.framework !== "string" ||
      typeof scaffold.path !== "string" ||
      scaffold.path.length === 0
    ) {
      throw invalid(`malformed scaffold entry: ${JSON.stringify(entry)}`, path);
    }
    if (findChoice(scaffold.slot, scaffold.framework) === undefined) {
      throw invalid(
        `scaffold "${scaffold.framework}" is not a known ${scaffold.slot} framework for this CLI version`,
        path,
      );
    }
    // generator and port are required by the schema: string-or-null, and a
    // valid TCP port or null. Hand-edited drift here would corrupt doctor
    // output and get re-saved by `groot add`.
    if (
      !("generator" in scaffold) ||
      (scaffold.generator !== null && typeof scaffold.generator !== "string")
    ) {
      throw invalid(
        `scaffold "${scaffold.path}" has a malformed generator (expected a string or null)`,
        path,
      );
    }
    if (
      !("port" in scaffold) ||
      (scaffold.port !== null &&
        (typeof scaffold.port !== "number" ||
          !Number.isInteger(scaffold.port) ||
          scaffold.port < 1 ||
          scaffold.port > 65535))
    ) {
      throw invalid(
        `scaffold "${scaffold.path}" has a malformed port (expected an integer 1-65535 or null)`,
        path,
      );
    }
  }
  return value as Manifest;
}

/**
 * Locate and load the manifest for the workspace containing `startDir`.
 * Throws EXIT.USAGE when no groot workspace is found or the manifest is invalid.
 */
export async function loadManifest(startDir: string): Promise<LoadedManifest> {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (workspaceRoot === null) {
    throw new GrootError(
      `No groot workspace found (searched for groot.json from ${startDir} upward).`,
      EXIT.USAGE,
      "Run this inside a workspace created by `groot init`.",
    );
  }
  const path = join(workspaceRoot, "groot.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error), path);
  }
  return { manifest: validateManifest(parsed, path), path, workspaceRoot };
}

/** Persist an updated manifest in place. */
export async function saveManifest(loaded: LoadedManifest, manifest: Manifest): Promise<void> {
  await writeFile(loaded.path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
