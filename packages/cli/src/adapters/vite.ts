/**
 * Vite adapter — docs/scaffold-flows.md#14. Seventh web-slot choice: the
 * no-framework React SPA, for when a meta-framework is more than the job
 * needs.
 *
 * `create-vite` is the cleanest generator in the matrix (all flags verified
 * against the published 9.1.1 bundle): `--template react-ts` (pinned — the
 * TS React template; 9.x templates default to Oxlint, kept as-is since the
 * workspace root owns linting anyway), `--no-interactive` (force
 * non-interactive), and `--no-immediate` — 9.x's `--immediate` would install
 * dependencies AND start the dev server; explicitly off. It never git-inits,
 * never writes a lockfile, and ships its gitignore as `_gitignore`, renamed
 * on copy. Port 5173 is the Vite default, shared with SvelteKit/React Router
 * per the same-slot rule. Build: `vite build` → dist/.
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

/** Pinned template — Vite's TS React template (see scaffold-flows.md#14). */
export const VITE_TEMPLATE = "react-ts";

export const viteAdapter: ScaffoldAdapter = {
  id: "vite",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "create-vite@9",
        name,
        "--template",
        VITE_TEMPLATE,
        "--no-interactive",
        "--no-immediate",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Vite)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const configPresent = ["vite.config.ts", "vite.config.js", "vite.config.mts"].some((file) =>
      existsSync(join(base, file)),
    );
    return [
      {
        name: `${ctx.scaffold.path} vite config`,
        status: configPresent ? "pass" : "warn",
        detail: configPresent ? "vite config present" : "no vite.config.{ts,js,mts} found",
        ...(configPresent
          ? {}
          : { fix: "Restore the Vite config the create-vite template ships." }),
      },
    ];
  },
};
