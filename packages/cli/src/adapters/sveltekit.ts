/**
 * SvelteKit adapter — docs/scaffold-flows.md#3.
 *
 * `sv` is the official scaffolder (create-svelte is deprecated). It never
 * git-inits; `--no-install` skips installation and `--no-dir-check` bypasses
 * its non-empty-target gate (groot's dir-conflict policy already ran).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

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
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    // sv ≥ 0.16: SvelteKit config lives in vite.config.ts plugin options
    // (no svelte.config.js) — see docs/scaffold-flows.md#3.
    const name = `${ctx.scaffold.path} sveltekit config`;
    try {
      const viteConfig = await readFile(
        join(ctx.workspaceRoot, ctx.scaffold.path, "vite.config.ts"),
        "utf8",
      );
      const ok = viteConfig.includes("sveltekit(");
      return [
        {
          name,
          status: ok ? "pass" : "warn",
          detail: ok
            ? "sveltekit() plugin configured in vite.config.ts"
            : "vite.config.ts has no sveltekit() plugin",
          ...(ok ? {} : { fix: "Re-add the sveltekit() plugin to vite.config.ts." }),
        },
      ];
    } catch {
      return [
        {
          name,
          status: "fail",
          detail: "vite.config.ts missing",
          fix: `Restore ${ctx.scaffold.path}/vite.config.ts or remove the scaffold from groot.json.`,
        },
      ];
    }
  },
};
