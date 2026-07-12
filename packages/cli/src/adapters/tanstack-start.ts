/**
 * TanStack Start adapter — docs/scaffold-flows.md#10. Third web-slot choice.
 *
 * `@tanstack/cli` (`tanstack create`) is fully non-interactive with `--yes`
 * plus explicit flags for everything groot cares about (all verified against
 * the published 0.69.5 source): `--framework React`, `--package-manager bun`,
 * `--no-git`, `--no-install`, `--no-examples` (skip demo pages),
 * `--no-toolchain` (no eslint/biome overlay — the workspace root owns
 * linting), and `--no-intent` (skip TanStack's agent skill files — groot's
 * own agent-era artifacts arrive with roadmap v1.3 and must not collide).
 * Like the other name-deriving generators, the positional is a NAME — the
 * spawn runs from the scaffold's parent with the bare basename.
 *
 * The template pins its dev port in the dev script (`vite dev --port 3000`),
 * not in vite.config — same default as Next.js, so single-web workspaces are
 * clean and `add --path` coexistence rides the standard collision warning.
 * Build is plain `vite build` → dist/ (no Nitro/.output in the 1.x template).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

export const tanstackStartAdapter: ScaffoldAdapter = {
  id: "tanstack-start",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "@tanstack/cli@0.69",
        "create",
        name,
        "--framework",
        "React",
        "--package-manager",
        "bun",
        "--no-git",
        "--no-install",
        "--no-examples",
        "--no-toolchain",
        "--no-intent",
        "--yes",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (TanStack Start)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const checks: DoctorCheck[] = [];

    // vite.config — the template's contract (tanstackStart plugin lives there).
    const configPresent = ["vite.config.ts", "vite.config.js"].some((file) =>
      existsSync(join(base, file)),
    );
    checks.push({
      name: `${ctx.scaffold.path} vite config`,
      status: configPresent ? "pass" : "warn",
      detail: configPresent ? "vite config present" : "no vite.config.{ts,js} found",
      ...(configPresent
        ? {}
        : { fix: "Restore the Vite config the TanStack Start template ships." }),
    });

    // The dev port lives in the dev script (`vite dev --port <n>`), so drift
    // between package.json and groot.json is detectable and worth flagging.
    if (ctx.scaffold.port !== null) {
      const name = `${ctx.scaffold.path} dev port`;
      try {
        const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        const dev = pkg.scripts?.dev ?? "";
        const matches = dev.includes(`--port ${ctx.scaffold.port}`);
        checks.push({
          name,
          status: matches ? "pass" : "warn",
          detail: matches
            ? `dev script serves on :${ctx.scaffold.port}`
            : `dev script no longer matches groot.json's port :${ctx.scaffold.port}`,
          ...(matches
            ? {}
            : { fix: "If the change is intentional, update the port in groot.json to match." }),
        });
      } catch {
        checks.push({
          name,
          status: "fail",
          detail: "package.json missing or unparseable",
          fix: `Restore ${ctx.scaffold.path}/package.json.`,
        });
      }
    }

    return checks;
  },
};
