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
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { TRUNK_EXAMPLE_PATHS, trunkCommand } from "../adapters/trunk.ts";
import type { FileSpec, GeneratorCommand } from "./adapter.ts";
import { EXIT, GrootError } from "./errors.ts";
import { runCommand } from "./run.ts";
import type { Plan, PlannedScaffold } from "./types.ts";

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

/**
 * Remove a `.git` a generator created inside a freshly-grown scaffold.
 *
 * Not every generator can be silenced by flags — `create-expo-app` has no
 * git-suppression flag and initializes a repo whenever it doesn't detect an
 * enclosing one, which is always the case during `groot init` (the root
 * `git init` runs in the verify stage, *after* generation). A nested repo
 * splits workspace history, so the engine removes it deterministically.
 *
 * Only generator-created entries are scrubbed: when `.git` existed before the
 * grow (`--dir-conflict merge` onto a directory the user already tracks), it
 * is the user's and is preserved. Returns true when a scrub happened.
 */
export async function scrubGeneratorGit(
  scaffoldDir: string,
  hadGitBefore: boolean,
): Promise<boolean> {
  const nestedGit = join(scaffoldDir, ".git");
  if (hadGitBefore || !existsSync(nestedGit)) {
    return false;
  }
  await rm(nestedGit, { recursive: true, force: true });
  return true;
}

export interface GenerateOptions {
  readonly verbose: boolean;
  /** Progress callback — receives a human label as each step starts. */
  readonly onStep?: (label: string) => void;
}

/**
 * Run a generator in a disposable staging directory under the OS tempdir,
 * then move its output into the scaffold path.
 *
 * This exists for generators that shell out to npm mid-generation —
 * fastify-cli's generate runs `npm init -y` inside its target
 * (docs/scaffold-flows.md#15). npm resolves its project root by walking up
 * from cwd, so inside a groot workspace it finds the bun-declared root
 * (create-turbo's `-m bun` writes devEngines) and hard-fails with
 * EBADDEVENGINES. The OS tempdir gives those generators a neutral ancestry —
 * the trunk's temp-sibling pattern, generalized.
 *
 * The command must create `name` (the scaffold path's basename) inside its
 * cwd, which the engine supersedes with the stage. The move prefers rename and
 * falls back to a copy for cross-device temp mounts.
 */
export async function runStagedGenerator(
  command: GeneratorCommand,
  name: string,
  destDir: string,
  options: Pick<GenerateOptions, "verbose">,
): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "groot-stage-"));
  try {
    await runCommand({ ...command, cwd: stage }, { verbose: options.verbose });
    const grown = join(stage, name);
    if (!existsSync(grown)) {
      throw new GrootError(
        `The generator finished but produced no "${name}" directory in its staging area`,
        EXIT.GENERATOR,
        "Re-run with --verbose to stream the full generator output.",
      );
    }
    try {
      await rename(grown, destDir);
    } catch {
      await cp(grown, destDir, { recursive: true });
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Grow one scaffold via its adapter: generator command → direct file writes →
 * post-commands. `generate` runs this for every scaffold in the plan; `groot add`
 * runs it for just the new one (no trunk).
 */
export async function growScaffold(
  plan: Plan,
  scaffold: PlannedScaffold,
  options: GenerateOptions,
): Promise<void> {
  const report = options.onStep ?? (() => {});
  const adapter = ADAPTERS[scaffold.framework];
  if (adapter === undefined) {
    throw new GrootError(`No adapter registered for "${scaffold.framework}"`, EXIT.INTERNAL);
  }
  const ctx = { plan, scaffold };
  const scaffoldDir = join(plan.targetDir, scaffold.path);

  // Generators create their own leaf directory; guarantee the parent exists.
  await mkdir(dirname(scaffoldDir), { recursive: true });

  // Snapshot BEFORE any step runs, so only generator-created .git is scrubbed.
  const hadNestedGit = existsSync(join(scaffoldDir, ".git"));

  const command = adapter.command(ctx);
  if (command !== null) {
    report(command.label);
    if (adapter.stagedGeneration) {
      await runStagedGenerator(command, basename(scaffold.path), scaffoldDir, options);
    } else {
      await runCommand(command, { verbose: options.verbose });
    }
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

  if (await scrubGeneratorGit(scaffoldDir, hadNestedGit)) {
    report(`Removed generator-created .git from ${scaffold.path}`);
  }
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
      await growScaffold(plan, scaffold, options);
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
