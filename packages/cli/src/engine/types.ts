/**
 * Core engine types — the shared vocabulary of the resolve → preflight → generate →
 * stitch → verify pipeline. Normative references: docs/architecture.md (pipeline,
 * adapter contract) and docs/cli-spec.md (flags, exit codes, manifest schema).
 */

/** The five scaffold slots a groot workspace can fill. */
export type Slot = "web" | "mobile" | "desktop" | "api" | "backend";

/** Framework identifiers accepted by the slot flags (`--web next`, `--api hono`, …). */
export type FrameworkId =
  | "next"
  | "sveltekit"
  | "tanstack-start"
  | "expo"
  | "tauri"
  | "electron"
  | "elysia"
  | "hono"
  | "convex";

/** The explicit "skip this slot" choice. */
export const NONE = "none" as const;
export type NoneChoice = typeof NONE;

/** What `--dir-conflict` does when the target directory already exists and is non-empty. */
export type DirConflictPolicy = "error" | "merge" | "increment";

/** Static metadata for one framework choice within a slot. */
export interface FrameworkMeta {
  readonly id: FrameworkId;
  /** Human label used in prompts and summaries ("Next.js"). */
  readonly label: string;
  /** Workspace-relative destination ("apps/web", "packages/backend"). */
  readonly path: string;
  /**
   * Deterministic dev port groot assigns at scaffold time, or null when the
   * scaffold has no local dev port (Convex uses a cloud dev deployment).
   * See docs/architecture.md#port-allocation.
   */
  readonly port: number | null;
  /**
   * Pinned generator invocation ("create-next-app@16"), or null when groot
   * writes the files directly (Elysia, Convex — see docs/scaffold-flows.md).
   */
  readonly generator: string | null;
}

/** One resolved scaffold inside a plan / groot.json manifest. */
export interface PlannedScaffold {
  readonly slot: Slot;
  readonly framework: FrameworkId;
  readonly path: string;
  readonly generator: string | null;
  readonly port: number | null;
}

/** Behavioral switches resolved from flags. */
export interface PlanOptions {
  readonly install: boolean;
  readonly git: boolean;
  readonly dirConflict: DirConflictPolicy;
  readonly keepFailed: boolean;
  readonly verbose: boolean;
}

/** The immutable output of the resolve stage — input to every later stage. */
export interface Plan {
  /** Workspace name (root package name). */
  readonly name: string;
  /** Absolute path of the target directory. */
  readonly targetDir: string;
  /** "create-groot@<version>" that produced this plan. */
  readonly createdWith: string;
  readonly conventions: { readonly packagesNamespace: string };
  readonly scaffolds: readonly PlannedScaffold[];
  readonly options: PlanOptions;
}

/** Current groot.json manifest schema version. */
export const MANIFEST_VERSION = 1 as const;

/** Public URL of the manifest JSON schema (also shipped at schemas/groot.schema.json). */
export const MANIFEST_SCHEMA_URL =
  "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json";

/** The groot.json manifest — written by init, consumed by add/doctor (and `--dry-run --json`). */
export interface Manifest {
  readonly $schema: string;
  readonly version: typeof MANIFEST_VERSION;
  readonly createdWith: string;
  readonly conventions: { readonly packagesNamespace: string };
  readonly scaffolds: readonly PlannedScaffold[];
}

/** Result of a single preflight check. */
export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
