/**
 * Generate stage (docs/architecture.md#3-generate): plant the trunk, clean its
 * example apps, then grow each selected scaffold via its adapter — generators
 * with silence flags, or direct file writes.
 *
 * Failure semantics (docs/architecture.md#failure-semantics): if groot created
 * the target directory and a step fails, the directory is removed unless
 * --keep-failed was passed.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { TRUNK_EXAMPLE_PATHS, trunkCommand } from "../adapters/trunk.ts";
import type { FileSpec } from "./adapter.ts";
import { EXIT, GrootError } from "./errors.ts";
import { runCommand } from "./run.ts";
import type { Plan } from "./types.ts";

/**
 * Move every entry of `srcDir` into `destDir` (created if missing). Throws
 * EXIT.GENERATOR listing collisions instead of overwriting anything — under
 * `--dir-conflict merge` pre-existing user files always win.
 */
export async function moveDirContents(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir);
  const collisions = entries.filter((entry) => existsSync(join(destDir, entry)));
  if (collisions.length > 0) {
    throw new GrootError(
      `Cannot merge the turborepo trunk into ${destDir} — these entries already exist: ${collisions.join(", ")}`,
      EXIT.GENERATOR,
      "Move or remove the conflicting entries, or scaffold into a fresh directory.",
    );
  }
  for (const entry of entries) {
    await rename(join(srcDir, entry), join(destDir, entry));
  }
}

/** Remove create-turbo's example apps/packages so branch generators can claim their paths. */
export async function cleanupTrunkExamples(targetDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const relPath of TRUNK_EXAMPLE_PATHS) {
    const absPath = join(targetDir, relPath);
    if (existsSync(absPath)) {
      await rm(absPath, { recursive: true, force: true });
      removed.push(relPath);
    }
  }
  return removed;
}

/** Write adapter-authored files (paths are workspace-relative). */
export async function writeFileSpecs(targetDir: string, specs: readonly FileSpec[]): Promise<void> {
  for (const spec of specs) {
    const absPath = join(targetDir, spec.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, spec.contents, "utf8");
  }
}

export interface GenerateOptions {
  readonly verbose: boolean;
  /** Progress callback — receives a human label as each step starts. */
  readonly onStep?: (label: string) => void;
}

/** Plant the trunk and grow every scaffold in the plan. */
export async function generate(plan: Plan, options: GenerateOptions): Promise<void> {
  const report = options.onStep ?? (() => {});
  const createdByGroot = !existsSync(plan.targetDir);

  try {
    // 1. Trunk: generate into a temp sibling, then move in (uniform merge support).
    const parent = dirname(plan.targetDir);
    await mkdir(parent, { recursive: true });
    // No leading dot and npm-name-safe: create-turbo derives the project name
    // from the directory basename and rejects invalid package names.
    const tmpDir = join(parent, `groot-trunk-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const trunk = trunkCommand(tmpDir, parent);
      report(trunk.label);
      await runCommand(trunk, { verbose: options.verbose });
      await moveDirContents(tmpDir, plan.targetDir);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    report("Clearing trunk example apps");
    await cleanupTrunkExamples(plan.targetDir);

    // 2. Branches, in slot order.
    for (const scaffold of plan.scaffolds) {
      const adapter = ADAPTERS[scaffold.framework];
      if (adapter === undefined) {
        throw new GrootError(`No adapter registered for "${scaffold.framework}"`, EXIT.INTERNAL);
      }
      const ctx = { plan, scaffold };

      // Generators create their own leaf directory; guarantee the parent exists.
      await mkdir(dirname(join(plan.targetDir, scaffold.path)), { recursive: true });

      const command = adapter.command(ctx);
      if (command !== null) {
        report(command.label);
        await runCommand(command, { verbose: options.verbose });
      }

      const files = adapter.writeFiles?.(ctx);
      if (files !== undefined && files.length > 0) {
        report(`Writing ${scaffold.path} (${scaffold.framework})`);
        await writeFileSpecs(plan.targetDir, files);
      }

      for (const post of adapter.postCommands?.(ctx) ?? []) {
        report(post.label);
        await runCommand(post, { verbose: options.verbose });
      }
    }
  } catch (error) {
    if (createdByGroot && !plan.options.keepFailed) {
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
  }
}
