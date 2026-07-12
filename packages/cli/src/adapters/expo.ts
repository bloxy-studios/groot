/**
 * Expo adapter — docs/scaffold-flows.md#4.
 *
 * The template tag is pinned explicitly: during the SDK 57 transition,
 * `create-expo-app` without `--template` scaffolds SDK 54. Expo has no
 * git-suppression flag — it git-inits its output whenever it doesn't detect
 * an enclosing repo, which is always the case during `groot init` (the root
 * `git init` runs in verify, after generation). The engine scrubs any
 * generator-created .git right after the scaffold grows (generate.ts);
 * the doctor check below remains as a tripwire for workspaces grown before
 * the scrub existed (< v1.0.1) or touched by hand. Metro auto-configures for
 * monorepos since SDK 52 — no metro.config workspace patches are needed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

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
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    // A nested .git splits workspace history. The engine scrubs generator-created
    // ones since v1.0.1; this tripwire still catches older workspaces and manual
    // re-inits inside the scaffold.
    const nestedGit = existsSync(join(ctx.workspaceRoot, ctx.scaffold.path, ".git"));
    return [
      {
        name: `${ctx.scaffold.path} git nesting`,
        status: nestedGit ? "fail" : "pass",
        detail: nestedGit ? "nested .git directory found" : "no nested .git",
        ...(nestedGit
          ? { fix: `Remove ${ctx.scaffold.path}/.git — the workspace root owns git history.` }
          : {}),
      },
    ];
  },
};
