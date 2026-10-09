/**
 * Single-app topology (`groot init <dir> --topology single`): one app at the
 * project root — no Turborepo trunk, no workspaces, no backend package.
 *
 * Generation reuses the slot adapters unchanged: the generator runs inside a
 * disposable sibling directory (the trunk's temp-sibling pattern), and its
 * output is moved into the target — so `--dir-conflict merge` behaves exactly
 * as it does for the trunk (pre-existing user files win; collisions abort).
 * Stitching runs only the operations that make sense for a root-level app,
 * against the real root (the monorepo stitch would write workspace files).
 */
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { EXIT, GrootError } from "./errors.ts";
import { type GenerateOptions, growScaffold, moveDirContents } from "./generate.ts";
import { stitchLock } from "./locks.ts";
import {
  stitchFastifyScripts,
  stitchHonoPort,
  stitchManifest,
  stitchRootGitignore,
  stitchTrustedDependencies,
} from "./stitch.ts";
import type { Plan, PlannedScaffold, Slot } from "./types.ts";

/** Slots that can be the single app (a backend package is not an app). */
export const SINGLE_APP_SLOTS: readonly Slot[] = ["web", "mobile", "desktop", "api"];

/**
 * Check a single-topology selection: exactly one app scaffold, no backend,
 * and a project directory name the chosen generator accepts.
 */
export function validateSingleSelection(
  scaffolds: readonly PlannedScaffold[],
  targetDir: string,
): PlannedScaffold {
  const backend = scaffolds.find((scaffold) => scaffold.slot === "backend");
  if (backend !== undefined) {
    throw new GrootError(
      `--topology single has no backend package (got --backend ${backend.framework}).`,
      EXIT.USAGE,
      "Use the default monorepo topology for Convex or Supabase backends.",
    );
  }
  const apps = scaffolds.filter((scaffold) => SINGLE_APP_SLOTS.includes(scaffold.slot));
  if (apps.length !== 1) {
    throw new GrootError(
      apps.length === 0
        ? "--topology single needs exactly one app (pass --web, --mobile, --desktop, or --api)."
        : `--topology single holds exactly one app; got ${apps.map((app) => `--${app.slot} ${app.framework}`).join(", ")}.`,
      EXIT.USAGE,
      "Use the default monorepo topology for several apps.",
    );
  }
  const app = apps[0] as PlannedScaffold;
  const veto = ADAPTERS[app.framework].validatePath?.(`apps/${basename(targetDir)}`);
  if (veto != null) {
    throw new GrootError(
      veto,
      EXIT.USAGE,
      "Choose a project directory name the generator accepts.",
    );
  }
  return { ...app, path: "." };
}

/** The same plan, re-rooted so its one scaffold IS the project root. */
export function singleRootPlan(plan: Plan, app: PlannedScaffold): Plan {
  return { ...plan, topology: "single", scaffolds: [{ ...app, path: "." }] };
}

/**
 * --keep-failed: preserve what the generator wrote. A target groot would have
 * created receives it (like the monorepo's kept target); an existing target
 * is never merged with partial output, so it stays in the stage. Returns
 * where the output is now (null = the generator wrote nothing).
 */
async function keepPartialOutput(output: string, target: string): Promise<string | null> {
  if (!existsSync(output)) return null;
  if (existsSync(target)) return output;
  try {
    await rename(output, target);
    return target;
  } catch {
    return output;
  }
}

/**
 * Generate the single app into `plan.targetDir`. On failure, a target groot
 * created is removed — unless --keep-failed, which keeps the generator's
 * partial output and names where (the trunk's failure semantics).
 */
export async function generateSingle(plan: Plan, options: GenerateOptions): Promise<void> {
  const report = options.onStep ?? (() => {});
  const app = plan.scaffolds[0];
  if (app === undefined) throw new GrootError("single-app plan has no scaffold", EXIT.INTERNAL);
  const createdByGroot = !existsSync(plan.targetDir);
  const parent = dirname(plan.targetDir);
  await mkdir(parent, { recursive: true });
  // npm-name-safe and dot-free: generators derive package names from it.
  const stage = join(parent, `groot-single-${crypto.randomUUID().slice(0, 8)}`);
  const name = basename(plan.targetDir);
  let keepStage = false;
  try {
    await mkdir(stage, { recursive: true });
    // Adapters resolve paths against plan.targetDir: point it at the stage
    // and the scaffold at the final directory name.
    await growScaffold({ ...plan, targetDir: stage }, { ...app, path: name }, options);
    report(`Moving ${name} into place`);
    await moveDirContents(join(stage, name), plan.targetDir);
  } catch (error) {
    if (plan.options.keepFailed) {
      const kept = await keepPartialOutput(join(stage, name), plan.targetDir);
      keepStage = kept !== null && kept !== plan.targetDir;
      if (kept !== null && error instanceof GrootError) {
        throw new GrootError(
          `${error.message}\nPartial output was kept in ${kept} (--keep-failed).`,
          error.exitCode,
          error.hint,
        );
      }
    } else if (createdByGroot) {
      await rm(plan.targetDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof GrootError) {
        throw new GrootError(
          `${error.message}\nThe partially-created directory was removed.`,
          error.exitCode,
          error.hint ?? "Pass --keep-failed to inspect partial output next time.",
        );
      }
    }
    throw error;
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

async function stitchSingleName(plan: Plan): Promise<string | null> {
  const path = join(plan.targetDir, "package.json");
  if (!existsSync(path)) return null;
  const pkg = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  if (pkg.name === plan.name && pkg.private === true) return null;
  pkg.name = plan.name;
  pkg.private = true;
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return `package.json → name "${plan.name}"`;
}

/** The root-level subset of the stitch stage for a single app. */
export async function stitchSingle(
  plan: Plan,
  options: { onStep?: (label: string) => void } = {},
): Promise<string[]> {
  options.onStep?.("Stitching single-app project");
  const notes: string[] = [];
  const push = (note: string | string[] | null): void => {
    if (note === null) return;
    if (Array.isArray(note)) notes.push(...note);
    else notes.push(note);
  };
  push(await stitchSingleName(plan));
  push(await stitchHonoPort(plan));
  push(await stitchFastifyScripts(plan));
  push(await stitchTrustedDependencies(plan));
  push(await stitchRootGitignore(plan));
  push(await stitchManifest(plan));
  push(stitchLock(plan));
  return notes;
}
