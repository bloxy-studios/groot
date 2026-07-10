/**
 * SvelteKit adapter — docs/scaffold-flows.md#3.
 *
 * `sv` is the official scaffolder (create-svelte is deprecated). It never
 * git-inits; `--no-install` skips installation and `--no-dir-check` bypasses
 * its non-empty-target gate (groot's dir-conflict policy already ran).
 */
import type { AdapterContext, GeneratorCommand, ScaffoldAdapter } from "../engine/adapter.ts";

export const sveltekitAdapter: ScaffoldAdapter = {
  id: "sveltekit",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    return {
      argv: [
        "bunx",
        "sv@0.16",
        "create",
        ctx.scaffold.path,
        "--template",
        "minimal",
        "--types",
        "ts",
        "--no-add-ons",
        "--no-install",
        "--no-dir-check",
      ],
      cwd: ctx.plan.targetDir,
      label: `Growing ${ctx.scaffold.path} (SvelteKit)`,
    };
  },
};
