/**
 * Nuxt adapter — docs/scaffold-flows.md#13. Sixth web-slot choice; the Vue
 * meta-framework.
 *
 * `create-nuxt` (the nuxt/cli scaffolder — package is 3.x even though Nuxt
 * itself is v4) is citty-based; all flags verified against the published
 * 3.36.1 source. Critical fact from that source: in non-interactive mode the
 * CLI REQUIRES dir, --template, --packageManager, and a gitInit decision
 * explicitly, or it exits 2 — so groot passes all four: the positional name,
 * `--template minimal` (the CLI's own default template, from the
 * nuxt/starter registry via giget), `--packageManager bun` (a first-class
 * option), and `--no-gitInit` (citty auto-negation). `--no-install` skips the
 * install; `--no-modules` skips the module-selection prompt.
 *
 * The template's `postinstall: nuxt prepare` runs during the root
 * `bun install` (workspace-local scripts always run under bun — this is not
 * a dependency lifecycle script). Port 3000 is `nuxt dev`'s built-in default,
 * shared with Next/TanStack per the same-slot rule. Build: `nuxt build` →
 * .output/ (Nitro), added to turbo's outputs.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

/** Pinned template — the CLI's default, from the nuxt/starter registry. */
export const NUXT_TEMPLATE = "minimal";

export const nuxtAdapter: ScaffoldAdapter = {
  id: "nuxt",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "create-nuxt@3",
        name,
        "--template",
        NUXT_TEMPLATE,
        "--packageManager",
        "bun",
        "--no-gitInit",
        "--no-install",
        "--no-modules",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Nuxt)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const configPresent = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"].some((file) =>
      existsSync(join(base, file)),
    );
    return [
      {
        name: `${ctx.scaffold.path} nuxt config`,
        status: configPresent ? "pass" : "warn",
        detail: configPresent ? "nuxt config present" : "no nuxt.config.{ts,js,mjs} found",
        ...(configPresent
          ? {}
          : { fix: "Restore the nuxt.config the create-nuxt template ships." }),
      },
    ];
  },
};
