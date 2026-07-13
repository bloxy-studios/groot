/**
 * Fastify adapter — docs/scaffold-flows.md#15. Second generator-backed api-slot
 * choice, riding fastify-cli's official `generate` (all facts verified against
 * the published 8.0.0 bundle).
 *
 * `fastify-cli generate` is fully non-interactive: it generify-copies the
 * template (renaming `__gitignore` → `.gitignore`), shells out to `npm init -y`
 * inside the target (the package name derives from the directory basename —
 * upstream behavior), merges the template's scripts/deps into package.json,
 * and exits. No install, no git init, no lockfile. It refuses existing
 * directories outright, so groot passes the bare basename — which also keeps
 * the npm-derived package name path-free. That npm call is why this adapter
 * sets stagedGeneration: inside the workspace, npm's walk-up would trip the
 * bun devEngines guard (EBADDEVENGINES) — the engine stages the generate under
 * the OS tempdir and moves the result in.
 *
 * groot pins the ESM TypeScript template (`--lang=ts --esm`): every groot
 * scaffold is ESM, and this template's tsconfig (`allowImportingTsExtensions` +
 * `rewriteRelativeImportExtensions`) lets groot's server entry import
 * `./app.ts` directly while `tsc` still emits clean JS to dist/. The generated
 * `src/app.ts` is an @fastify/autoload plugin, not a listener — upstream
 * expects its Node-centric `fastify start` wrapper to serve it. groot instead
 * overlays `src/server.ts` (modeled on fastify-cli's own eject template) that
 * registers the app plugin and listens on the plan port; the stitch stage
 * swaps the package scripts to run it under bun (see stitchFastifyScripts).
 * @fastify/autoload ≥ 6 detects bun (`'Bun' in globalThis`) and loads the .ts
 * plugins/routes natively — no compile step, no env var.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  FileSpec,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";
import { apiPortCheck } from "./elysia.ts";

/**
 * Bun-native server entry groot overlays next to the generated app plugin.
 * Mirrors fastify-cli's eject template (register the plugin, listen, log the
 * failure) minus `close-with-grace` — that dependency belongs to the eject
 * flow, not the generated app's dependency set. The `port: N }` shape is the
 * doctor's drift marker; keep them in sync.
 */
export function fastifyServerTs(port: number): string {
  return `/**
 * Server entry written by groot, modeled on fastify-cli's eject template:
 * it registers the generated app plugin (src/app.ts autoloads plugins/ and
 * routes/) and listens on the workspace's assigned port. Run it with bun —
 * @fastify/autoload detects the bun runtime and loads the .ts files directly.
 */
import Fastify from "fastify";
import app from "./app.ts";

const server = Fastify({ logger: true });

await server.register(app);

try {
  await server.listen({ port: ${port} });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
`;
}

export const fastifyAdapter: ScaffoldAdapter = {
  id: "fastify",
  slot: "api",
  // generate shells out to `npm init -y`, and npm's project-root walk-up
  // hard-fails on the workspace's bun devEngines declaration (EBADDEVENGINES —
  // caught live in e2e scenario 4). Staging runs it under the OS tempdir with
  // a neutral ancestry, then the engine moves the output into apps/api.
  stagedGeneration: true,
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: ["bunx", "fastify-cli@8", "generate", name, "--lang=ts", "--esm"],
      // generate refuses existing directories and derives the package name via
      // `npm init -y` — the bare basename keeps that name path-free. The cwd
      // is superseded by the staging directory (see stagedGeneration).
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Fastify)`,
    };
  },
  writeFiles(ctx: AdapterContext): FileSpec[] {
    // Port is always assigned for api scaffolds (see engine/matrix.ts).
    const port = ctx.scaffold.port ?? 3001;
    return [{ path: `${ctx.scaffold.path}/src/server.ts`, contents: fastifyServerTs(port) }];
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    // The ` }` bound keeps the includes-based check from matching a longer
    // port (`port: 3001 }` never matches inside `port: 30011 }`).
    const portCheck = await apiPortCheck(ctx, `port: ${ctx.scaffold.port} }`, "src/server.ts");
    const appPresent = existsSync(join(ctx.workspaceRoot, ctx.scaffold.path, "src/app.ts"));
    return [
      portCheck,
      {
        name: `${ctx.scaffold.path} app plugin`,
        status: appPresent ? "pass" : "fail",
        detail: appPresent
          ? "src/app.ts present (autoload root registered by src/server.ts)"
          : "src/app.ts missing — src/server.ts has nothing to register",
        ...(appPresent
          ? {}
          : {
              fix: `Restore ${ctx.scaffold.path}/src/app.ts or remove the scaffold from groot.json.`,
            }),
      },
    ];
  },
};
