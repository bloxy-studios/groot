/**
 * Expo adapter — docs/scaffold-flows.md#4.
 *
 * The template tag is pinned explicitly: during the SDK 57 transition,
 * `create-expo-app` without `--template` scaffolds SDK 54. Expo has no
 * git-suppression flag, but skips git init inside an existing repo; a doctor
 * check (v0.3) verifies no nested .git appeared. Metro auto-configures for
 * monorepos since SDK 52 — no metro.config workspace patches are needed.
 */
import type { AdapterContext, GeneratorCommand, ScaffoldAdapter } from "../engine/adapter.ts";

/** Pinned Expo template (SDK line) — update alongside docs/scaffold-flows.md. */
export const EXPO_TEMPLATE = "default@sdk-57";

export const expoAdapter: ScaffoldAdapter = {
  id: "expo",
  slot: "mobile",
  command(ctx: AdapterContext): GeneratorCommand {
    return {
      argv: [
        "bunx",
        "create-expo-app@4",
        ctx.scaffold.path,
        "--template",
        EXPO_TEMPLATE,
        "--no-install",
        "--yes",
      ],
      cwd: ctx.plan.targetDir,
      label: `Growing ${ctx.scaffold.path} (Expo)`,
    };
  },
};
