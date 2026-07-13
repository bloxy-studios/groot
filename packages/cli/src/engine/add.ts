/**
 * Add stage (docs/cli-spec.md#groot-add-scaffold-v03): grow one more scaffold in
 * an existing groot workspace. The init pipeline's stages are reused for just
 * the new scaffold — `growScaffold` (no trunk), then a full `stitch` (idempotent
 * over the existing scaffolds, so cross-wiring like backend links and the
 * groot.json update land automatically), then `verify`.
 */
import { readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { EXIT, GrootError } from "./errors.ts";
import { growScaffold } from "./generate.ts";
import type { LoadedManifest } from "./manifest.ts";
import { findChoice, MATRIX, SLOT_ORDER } from "./matrix.ts";
import { isNonEmptyDir } from "./preflight.ts";
import { stitch } from "./stitch.ts";
import type { FrameworkMeta, Manifest, Plan, PlannedScaffold, Slot } from "./types.ts";
import { verify } from "./verify.ts";

/** Every framework id `add` accepts, in slot order (for usage hints). */
export function allFrameworkIds(): string[] {
  return SLOT_ORDER.flatMap((slot) => MATRIX[slot].choices.map((choice) => choice.id));
}

/** Resolve a framework id to its slot + metadata, or undefined for unknown ids. */
export function frameworkChoice(
  framework: string,
): { slot: Slot; meta: FrameworkMeta } | undefined {
  for (const slot of SLOT_ORDER) {
    const meta = findChoice(slot, framework);
    if (meta !== undefined) return { slot, meta };
  }
  return undefined;
}

/**
 * Normalize a `--path` override to the manifest's workspace-relative form.
 * Destinations are constrained to direct children of apps/ or packages/ — the
 * workspace globs stitch guarantees — so every grown scaffold is a real
 * workspace member that `bun install` picks up.
 */
export function normalizeScaffoldPath(input: string, workspaceRoot: string): string {
  if (input.trim().length === 0) {
    throw new GrootError("--path cannot be empty.", EXIT.USAGE);
  }
  const rel = relative(workspaceRoot, resolve(workspaceRoot, input.trim()));
  // isAbsolute guards the Windows cross-drive case, where relative() stays absolute.
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new GrootError(
      `--path must point inside the workspace: "${input}"`,
      EXIT.USAGE,
      "Pass a path relative to the workspace root, like apps/marketing.",
    );
  }
  const normalized = rel.split(sep).join("/");
  if (!/^(apps|packages)\/[^/]+$/.test(normalized)) {
    throw new GrootError(
      `--path must be a direct child of apps/ or packages/ (got "${normalized}").`,
      EXIT.USAGE,
      'The workspace globs are "apps/*" and "packages/*" — a scaffold outside them would not be installed as a workspace package.',
    );
  }
  return normalized;
}

export interface AddResolution {
  /** The scaffold `add` would grow. */
  readonly scaffold: PlannedScaffold;
  /** Non-fatal findings to surface (port collisions — `groot doctor` flags them persistently). */
  readonly warnings: readonly string[];
}

/**
 * Validate the framework id and resolve the destination:
 *
 * - unknown framework → EXIT.USAGE
 * - **occupancy rule**: a slot that is already filled is refused unless `--path`
 *   targets a fresh directory; path equality with any existing scaffold is
 *   always refused. The backend slot is single-occupancy — its package name
 *   (`<namespace>/backend`) is fixed by the workspace conventions, so a second
 *   backend could never install.
 * - `--path` must stay in the slot's conventional tree (apps/ for web/mobile/api,
 *   packages/ for backend) so stitch's bare-name renames keep every workspace
 *   package name unique
 * - the destination must be fresh — absent or an empty directory
 * - a dev-port collision with an existing scaffold is a **warning**, not an
 *   error — `groot doctor` keeps flagging it until one port changes
 */
export async function resolveAddScaffold(
  manifest: Manifest,
  workspaceRoot: string,
  framework: string,
  pathOverride: string | undefined,
): Promise<AddResolution> {
  const choice = frameworkChoice(framework);
  if (choice === undefined) {
    throw new GrootError(
      `Unknown scaffold "${framework}".`,
      EXIT.USAGE,
      `Valid scaffolds: ${allFrameworkIds().join(" | ")}`,
    );
  }
  const { slot, meta } = choice;

  const occupant = manifest.scaffolds.find((scaffold) => scaffold.slot === slot);
  if (occupant !== undefined && slot === "backend") {
    throw new GrootError(
      `The backend slot is already filled by ${occupant.framework} at ${occupant.path}.`,
      EXIT.USAGE,
      `A groot workspace has a single backend — its package name (${manifest.conventions.packagesNamespace}/backend) is fixed by the workspace conventions.`,
    );
  }
  if (occupant !== undefined && pathOverride === undefined) {
    throw new GrootError(
      `The ${slot} slot is already filled by ${occupant.framework} at ${occupant.path}.`,
      EXIT.USAGE,
      `Pass --path (a fresh apps/<name> directory) to grow another ${slot} scaffold alongside it.`,
    );
  }

  const path =
    pathOverride === undefined ? meta.path : normalizeScaffoldPath(pathOverride, workspaceRoot);
  const slash = meta.path.indexOf("/");
  const expectedTop = slash === -1 ? meta.path : meta.path.slice(0, slash);
  if (!path.startsWith(`${expectedTop}/`)) {
    throw new GrootError(
      `${slot} scaffolds live under ${expectedTop}/ (got "${path}").`,
      EXIT.USAGE,
      `Pass --path ${expectedTop}/<name>.`,
    );
  }
  // Some generators derive identifiers from the path's basename and reject
  // names their rules don't allow — refuse those up front instead of letting
  // the generator crash mid-grow (bare RN validates JS-identifier names).
  const pathVeto = ADAPTERS[meta.id].validatePath?.(path);
  if (pathVeto != null) {
    throw new GrootError(pathVeto, EXIT.USAGE, "Pick a different --path.");
  }
  const claimant = manifest.scaffolds.find((scaffold) => scaffold.path === path);
  if (claimant !== undefined) {
    throw new GrootError(
      `${path} already belongs to the ${claimant.framework} scaffold in groot.json.`,
      EXIT.USAGE,
      "Pick a different --path.",
    );
  }
  if (await isNonEmptyDir(join(workspaceRoot, path))) {
    throw new GrootError(
      `${path} already exists and is not empty.`,
      EXIT.USAGE,
      "groot add only grows into fresh directories — move the existing files or pick a different --path.",
    );
  }

  const warnings: string[] = [];
  if (meta.port !== null) {
    const portOwner = manifest.scaffolds.find((scaffold) => scaffold.port === meta.port);
    if (portOwner !== undefined) {
      warnings.push(
        `dev port ${meta.port} is already used by ${portOwner.path} — change one scaffold's port afterwards (\`groot doctor\` flags this until it's fixed).`,
      );
    }
  }

  return {
    scaffold: { slot, framework: meta.id, path, generator: meta.generator, port: meta.port },
    warnings,
  };
}

/**
 * The workspace's current root package name. `add` plans reuse it so stitch —
 * which re-writes root identity — never renames an existing workspace.
 * Falls back to the directory basename when the name field is absent (stitch
 * then repairs the root package.json, same as init).
 */
export async function readRootPackageName(workspaceRoot: string): Promise<string> {
  const path = join(workspaceRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new GrootError(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.USAGE,
      "A groot workspace needs a parseable root package.json — run `groot doctor` for a full health report.",
    );
  }
  const name =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).name
      : undefined;
  return typeof name === "string" && name.length > 0 ? name : basename(workspaceRoot);
}

export interface AddPlanOptions {
  readonly install: boolean;
  readonly keepFailed: boolean;
  readonly verbose: boolean;
}

/**
 * Project the loaded manifest + the new scaffold into a Plan for the shared
 * pipeline stages. `createdWith` keeps the manifest's original value — it
 * records which CLI planted the workspace, not which one last grew it.
 */
export function buildAddPlan(
  loaded: LoadedManifest,
  scaffold: PlannedScaffold,
  rootPackageName: string,
  options: AddPlanOptions,
): Plan {
  return {
    name: rootPackageName,
    targetDir: loaded.workspaceRoot,
    createdWith: loaded.manifest.createdWith,
    conventions: loaded.manifest.conventions,
    scaffolds: [...loaded.manifest.scaffolds, scaffold],
    options: {
      install: options.install,
      // add never initializes git: init-created workspaces already have .git
      // (verify's git step self-skips), and a workspace planted with --no-git
      // must not gain a repository from a grow operation.
      git: false,
      dirConflict: "error",
      keepFailed: options.keepFailed,
      verbose: options.verbose,
    },
  };
}

/**
 * Targeted rollback (docs/cli-spec.md#groot-add-scaffold-v03): when growing
 * fails, remove ONLY the new scaffold directory — never the workspace — unless
 * `--keep-failed` asks to keep it. The destination was verified fresh, so the
 * removal can never touch user files.
 */
export async function growWithRollback(
  scaffoldDir: string,
  keepFailed: boolean,
  grow: () => Promise<void>,
): Promise<void> {
  try {
    await grow();
  } catch (error) {
    if (!keepFailed) {
      await rm(scaffoldDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof GrootError) {
        throw new GrootError(
          `${error.message}\nThe partially-grown scaffold was removed; the rest of the workspace is untouched.`,
          error.exitCode,
          error.hint ?? "Pass --keep-failed to inspect partial output next time.",
        );
      }
    }
    throw error;
  }
}

export interface ExecuteAddOptions {
  readonly verbose: boolean;
  /** Progress callback — receives a human label as each step starts. */
  readonly onStep?: (label: string) => void;
}

/**
 * Run the pipeline for one new scaffold: grow (with targeted rollback) → full
 * stitch (idempotent; persists the updated groot.json) → verify (structural
 * checks + root install unless the plan skips it). Returns the stitch + verify
 * notes.
 */
export async function executeAdd(
  plan: Plan,
  scaffold: PlannedScaffold,
  options: ExecuteAddOptions,
): Promise<string[]> {
  await growWithRollback(join(plan.targetDir, scaffold.path), plan.options.keepFailed, () =>
    growScaffold(plan, scaffold, { verbose: options.verbose, onStep: options.onStep }),
  );
  const notes = await stitch(plan, { onStep: options.onStep });
  return [...notes, ...(await verify(plan, { verbose: options.verbose, onStep: options.onStep }))];
}
