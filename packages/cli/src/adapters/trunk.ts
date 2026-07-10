/**
 * The Turborepo trunk — planted first, before any branch scaffold.
 * Reference: docs/scaffold-flows.md#1 (create-turbo).
 *
 * The trunk is generated into a temporary sibling directory and moved into the
 * target, which keeps `--dir-conflict merge` uniform and sidesteps create-turbo's
 * fresh-directory expectations. Its example apps are then removed so branch
 * generators (which refuse non-empty targets) can claim their paths; only
 * packages/typescript-config is kept and extended.
 */
import type { GeneratorCommand } from "../engine/adapter.ts";

/** Pinned major for the trunk generator. */
export const TRUNK_GENERATOR = "create-turbo@2";

/**
 * Example paths from create-turbo's `basic` template that groot removes.
 * (Kept: packages/typescript-config — the stitch stage extends it.)
 */
export const TRUNK_EXAMPLE_PATHS: readonly string[] = [
  "apps/web",
  "apps/docs",
  "packages/ui",
  "packages/eslint-config",
];

/**
 * The trunk invocation. `--skip-transforms` must never be added: the transforms
 * are what convert the pnpm-flavored example to bun (-m bun).
 */
export function trunkCommand(intoDir: string, parentCwd: string): GeneratorCommand {
  return {
    argv: ["bunx", TRUNK_GENERATOR, intoDir, "-m", "bun", "--skip-install", "--no-git"],
    cwd: parentCwd,
    label: "Planting turborepo trunk",
  };
}
