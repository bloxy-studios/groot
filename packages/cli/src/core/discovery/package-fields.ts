/**
 * The package.json fields discovery reads — untrusted JSON narrowed to plain
 * strings and string records (non-string entries are dropped, never coerced),
 * plus the manifest/entry shapes the unit analyzers share.
 */
import type { Sha256 } from "../contracts/common.ts";
import type { TextFile } from "./fs.ts";

export interface PackageFields {
  readonly name: string | null;
  readonly scripts: Record<string, string>;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly main: string | null;
  readonly module: string | null;
  readonly hasExports: boolean;
  /** Declares executables (a distributable CLI package). */
  readonly hasBin: boolean;
  readonly types: string | null;
}

/** A unit's package.json as read: its project path, byte hash, and fields. */
export interface UnitManifest {
  readonly path: string;
  readonly sha256: Sha256 | null;
  readonly fields: PackageFields;
}

/** The entry file's text (for port and server scans) and its project path. */
export interface EntrySource {
  readonly path: string;
  readonly file: TextFile;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function packageFields(value: Readonly<Record<string, unknown>>): PackageFields {
  return {
    name: stringOrNull(value.name),
    scripts: stringRecord(value.scripts),
    dependencies: stringRecord(value.dependencies),
    devDependencies: stringRecord(value.devDependencies),
    main: stringOrNull(value.main),
    module: stringOrNull(value.module),
    hasExports: value.exports !== undefined && value.exports !== null,
    hasBin: value.bin !== undefined && value.bin !== null,
    types: stringOrNull(value.types) ?? stringOrNull(value.typings),
  };
}

/** Every declared package (dependencies win over devDependencies for the version shown). */
export function declaredPackages(fields: PackageFields): Record<string, string> {
  return { ...fields.devDependencies, ...fields.dependencies };
}
