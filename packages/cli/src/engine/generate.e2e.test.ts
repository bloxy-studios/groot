/**
 * End-to-end generate-stage tests: run the REAL upstream generators.
 *
 * Network + registry dependent and slow (minutes), so they only run when
 * explicitly requested:  GROOT_E2E=1 bun test generate.e2e
 * A dedicated CI job wires these in at the end of the engine series (PR D).
 * Expo is exercised there too but excluded here — its template download is
 * the largest by far.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAddPlan, executeAdd, readRootPackageName, resolveAddScaffold } from "./add.ts";
import { isHealthy, runDoctor } from "./doctor.ts";
import { generate } from "./generate.ts";
import { loadManifest } from "./manifest.ts";
import { buildPlan } from "./plan.ts";
import { stitch } from "./stitch.ts";
import type { PlanOptions, Slot } from "./types.ts";
import { verify } from "./verify.ts";

const e2e = process.env.GROOT_E2E === "1";
const TIMEOUT_MS = 420_000;

async function planFor(
  selections: Record<Slot, string>,
  name: string,
  optionOverrides: Partial<PlanOptions> = {},
) {
  const base = await mkdtemp(join(tmpdir(), "groot-e2e-"));
  return buildPlan({
    name,
    targetDir: join(base, name),
    cliVersion: "0.2.0-e2e",
    selections,
    options: {
      install: false,
      git: false,
      dirConflict: "error",
      keepFailed: false,
      verbose: false,
      ...optionOverrides,
    },
  });
}

describe.skipIf(!e2e)("full pipeline (real generators — flagship: next + elysia + convex)", () => {
  test(
    "generate → stitch → verify produces an installed, coherent workspace",
    async () => {
      const plan = await planFor(
        { web: "next", mobile: "none", api: "elysia", backend: "convex" },
        "flagship",
        { install: true }, // real root bun install — the whole point of verify
      );
      const steps: string[] = [];
      await generate(plan, { verbose: false, onStep: (label) => steps.push(label) });
      await stitch(plan, { onStep: (label) => steps.push(label) });
      const verifyNotes = await verify(plan, {
        verbose: false,
        onStep: (label) => steps.push(label),
      });

      const root = plan.targetDir;
      // Trunk planted + converted to bun workspaces, examples cleared.
      const rootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      expect(rootPkg.workspaces ?? rootPkg.workspaces?.packages).toBeDefined();
      expect(existsSync(join(root, "turbo.json"))).toBe(true);
      expect(existsSync(join(root, "packages/typescript-config"))).toBe(true);
      expect(existsSync(join(root, "apps/docs"))).toBe(false);

      // Next.js grew into the cleared apps/web.
      expect(existsSync(join(root, "apps/web/package.json"))).toBe(true);
      expect(existsSync(join(root, "apps/web/next.config.ts"))).toBe(true);
      expect(existsSync(join(root, "apps/web/.git"))).toBe(false);

      // Elysia files written with the assigned port.
      const api = await readFile(join(root, "apps/api/src/index.ts"), "utf8");
      expect(api).toContain(".listen(3001)");

      // Convex: vendored _generated stubs + tsconfig in place.
      expect(existsSync(join(root, "packages/backend/convex/_generated/api.d.ts"))).toBe(true);
      expect(existsSync(join(root, "packages/backend/convex/tsconfig.json"))).toBe(true);

      // Stitch: identity, backend link, env plumbing, manifest, lockfile hygiene.
      const stitchedRootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      expect(stitchedRootPkg.name).toBe("flagship");
      const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
      expect(webPkg.name).toBe("web");
      expect(webPkg.dependencies["@repo/backend"]).toBe("workspace:*");
      expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
        "NEXT_PUBLIC_CONVEX_URL=",
      );
      const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
      expect(manifest.createdWith).toBe("create-groot@0.2.0-e2e");
      expect(existsSync(join(root, "apps/web/bun.lock"))).toBe(false);
      const turbo = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
      expect(turbo.tasks.build.outputs).toContain(".next/**");

      // Verify: the workspace actually installs — one root lockfile, resolvable workspace deps.
      expect(verifyNotes.join("\n")).toContain("bun install OK");
      expect(existsSync(join(root, "bun.lock"))).toBe(true);
      expect(existsSync(join(root, "node_modules"))).toBe(true);
      // Bun links workspace deps inside the depending app's node_modules.
      expect(existsSync(join(root, "apps/web/node_modules/@repo/backend"))).toBe(true);

      // The scaffolded packages must TYPECHECK, not just install — `convex dev`
      // runs tsc before pushing functions (caught live: missing @types/node).
      for (const pkgDir of ["packages/backend", "apps/api"]) {
        const proc = Bun.spawn(["bun", "run", "typecheck"], {
          cwd: join(root, pkgDir),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, `${pkgDir} typecheck failed:\n${out}\n${err}`).toBe(0);
      }

      expect(steps.length).toBeGreaterThanOrEqual(6);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!e2e)("full pipeline (real generators — alt web/api: sveltekit + hono)", () => {
  test(
    "grows and stitches sveltekit + hono (names + port rewrites applied)",
    async () => {
      const plan = await planFor(
        { web: "sveltekit", mobile: "none", api: "hono", backend: "none" },
        "altstack",
      );
      await generate(plan, { verbose: false });
      await stitch(plan);
      await verify(plan, { verbose: false });

      const root = plan.targetDir;
      // No generator left a nested repo behind (engine scrub — upstream drift tripwire).
      expect(existsSync(join(root, "apps/web/.git"))).toBe(false);
      expect(existsSync(join(root, "apps/api/.git"))).toBe(false);
      // sv ≥ 0.16 folds SvelteKit config into vite.config.ts (no svelte.config.js).
      const viteConfig = await readFile(join(root, "apps/web/vite.config.ts"), "utf8");
      expect(viteConfig).toContain("sveltekit(");
      expect(existsSync(join(root, "apps/web/src/routes/+page.svelte"))).toBe(true);
      // sv names the package after the path argument; stitch fixes it.
      const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
      expect(webPkg.name).toBe("web");

      const honoPkg = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));
      expect(honoPkg.dependencies.hono).toBeDefined();
      // Stitch rewrites Bun's default-export port so the API doesn't collide with web.
      const honoIndex = await readFile(join(root, "apps/api/src/index.ts"), "utf8");
      expect(honoIndex).toContain("port: 3001");
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!e2e)(
  "scenario 3: grow an existing workspace (init next → add elysia → add convex)",
  () => {
    test(
      "adds run the pipeline for just the new scaffold and doctor stays healthy",
      async () => {
        // Plant a web-only workspace with the real generators.
        const plan = await planFor(
          { web: "next", mobile: "none", api: "none", backend: "none" },
          "grown",
        );
        await generate(plan, { verbose: false });
        await stitch(plan);
        await verify(plan, { verbose: false });
        const root = plan.targetDir;

        // `groot add <framework>` — composed exactly as commands/add.ts does.
        const addOnce = async (framework: string) => {
          const loaded = await loadManifest(root);
          const resolution = await resolveAddScaffold(
            loaded.manifest,
            loaded.workspaceRoot,
            framework,
            undefined,
          );
          const addPlan = buildAddPlan(
            loaded,
            resolution.scaffold,
            await readRootPackageName(loaded.workspaceRoot),
            { install: false, keepFailed: false, verbose: false },
          );
          await executeAdd(addPlan, resolution.scaffold, { verbose: false });
          return resolution;
        };

        const elysia = await addOnce("elysia");
        expect(elysia.warnings).toEqual([]);
        const api = await readFile(join(root, "apps/api/src/index.ts"), "utf8");
        expect(api).toContain(".listen(3001)");

        await addOnce("convex");
        // The full (idempotent) stitch after adding convex wires the EXISTING web app.
        const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
        expect(webPkg.dependencies["@repo/backend"]).toBe("workspace:*");
        expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
          "NEXT_PUBLIC_CONVEX_URL=",
        );

        // No add left a nested repo inside its scaffold (engine scrub).
        expect(existsSync(join(root, "apps/api/.git"))).toBe(false);
        expect(existsSync(join(root, "packages/backend/.git"))).toBe(false);

        // groot.json grew to three scaffolds and kept its provenance.
        const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
        expect(manifest.scaffolds).toHaveLength(3);
        expect(manifest.scaffolds.map((s: { slot: string }) => s.slot).sort()).toEqual([
          "api",
          "backend",
          "web",
        ]);
        expect(manifest.createdWith).toBe("create-groot@0.2.0-e2e");

        // The grown workspace is healthy (warns allowed — no install ran here).
        const checks = await runDoctor(await loadManifest(root));
        const failures = checks.filter((check) => check.status === "fail");
        expect(isHealthy(checks), JSON.stringify(failures, null, 2)).toBe(true);
      },
      TIMEOUT_MS,
    );
  },
);
