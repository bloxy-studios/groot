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
import { dirname, join } from "node:path";
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

describe.skipIf(!e2e)("full pipeline (real generators — flagship + electron desktop)", () => {
  test(
    "generate → stitch → verify produces an installed, coherent workspace",
    async () => {
      const plan = await planFor(
        { web: "next", mobile: "none", desktop: "electron", api: "elysia", backend: "convex" },
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

      // Electron grew into apps/desktop from the REAL @quick-start/create-electron.
      expect(existsSync(join(root, "apps/desktop/electron.vite.config.ts"))).toBe(true);
      expect(existsSync(join(root, "apps/desktop/package.json"))).toBe(true);
      expect(existsSync(join(root, "apps/desktop/.git"))).toBe(false);
      const desktopPkg = JSON.parse(
        await readFile(join(root, "apps/desktop/package.json"), "utf8"),
      );
      expect(desktopPkg.name).toBe("desktop");
      // turbo caches electron-vite's out/ build dir.
      const turboAfter = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
      expect(turboAfter.tasks.build.outputs).toContain("out/**");
      // Stitch granted bun trust for electron's postinstall BEFORE the install
      // (electron is NOT on bun's default-trusted list — this run proves the
      // grant is what makes the runtime download below happen).
      const rootAfterStitch = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      expect(rootAfterStitch.trustedDependencies).toContain("electron");

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
      // Electron's postinstall (runtime binary download) ran under bun — via
      // the stitched trustedDependencies grant (NOT default-trusted; verified
      // 2026-07-12 on bun 1.3.14 when this failed without the grant). Resolved
      // from the app dir: bun 1.3's isolated layout keeps the package in the
      // node_modules/.bun store — there is no top-level node_modules/electron.
      const electronPkgDir = dirname(
        Bun.resolveSync("electron/package.json", join(root, "apps/desktop")),
      );
      expect(existsSync(join(electronPkgDir, "dist"))).toBe(true);

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

describe.skipIf(!e2e)("full pipeline (real generators — sveltekit + hono + add tanstack)", () => {
  test(
    "grows and stitches sveltekit + hono, then adds tanstack-start at apps/landing",
    async () => {
      const plan = await planFor(
        { web: "sveltekit", mobile: "none", desktop: "none", api: "hono", backend: "none" },
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

      // Grow a SECOND web scaffold via --path: the REAL tanstack create.
      // sveltekit(5173) + hono(3001) + tanstack(3000) → no port collisions.
      const loaded = await loadManifest(root);
      const resolution = await resolveAddScaffold(
        loaded.manifest,
        loaded.workspaceRoot,
        "tanstack-start",
        "apps/landing",
      );
      expect(resolution.warnings).toEqual([]);
      const addPlan = buildAddPlan(
        loaded,
        resolution.scaffold,
        await readRootPackageName(loaded.workspaceRoot),
        { install: false, keepFailed: false, verbose: false },
      );
      await executeAdd(addPlan, resolution.scaffold, { verbose: false });

      expect(existsSync(join(root, "apps/landing/vite.config.ts"))).toBe(true);
      expect(existsSync(join(root, "apps/landing/.git"))).toBe(false);
      const landingPkg = JSON.parse(
        await readFile(join(root, "apps/landing/package.json"), "utf8"),
      );
      expect(landingPkg.name).toBe("landing"); // stitch renames from the generator's choice
      expect(landingPkg.scripts.dev).toContain("--port 3000"); // template's own dev-script port
      const grownManifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
      expect(grownManifest.scaffolds).toHaveLength(3);
      expect(grownManifest.scaffolds.map((s: { slot: string }) => s.slot).sort()).toEqual([
        "api",
        "web",
        "web",
      ]); // astro joins below → 4

      // And a THIRD web scaffold: the REAL create-astro at apps/blog.
      // sveltekit(5173) + hono(3001) + tanstack(3000) + astro(4321) — all unique.
      const loaded2 = await loadManifest(root);
      const astroRes = await resolveAddScaffold(
        loaded2.manifest,
        loaded2.workspaceRoot,
        "astro",
        "apps/blog",
      );
      expect(astroRes.warnings).toEqual([]);
      const astroPlan = buildAddPlan(
        loaded2,
        astroRes.scaffold,
        await readRootPackageName(loaded2.workspaceRoot),
        { install: false, keepFailed: false, verbose: false },
      );
      await executeAdd(astroPlan, astroRes.scaffold, { verbose: false });

      expect(existsSync(join(root, "apps/blog/astro.config.mjs"))).toBe(true);
      expect(existsSync(join(root, "apps/blog/.git"))).toBe(false);
      const blogPkg = JSON.parse(await readFile(join(root, "apps/blog/package.json"), "utf8"));
      expect(blogPkg.name).toBe("blog");

      // Three web scaffolds, unique ports, healthy workspace.
      const finalManifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
      expect(finalManifest.scaffolds).toHaveLength(4);
      const checks = await runDoctor(await loadManifest(root));
      const failures = checks.filter((check) => check.status === "fail");
      expect(isHealthy(checks), JSON.stringify(failures, null, 2)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!e2e)(
  "scenario 3: grow an existing workspace (add elysia → convex → react-router → tauri)",
  () => {
    test(
      "adds run the pipeline for just the new scaffold and doctor stays healthy",
      async () => {
        // Plant a web-only workspace with the real generators.
        const plan = await planFor(
          { web: "next", mobile: "none", desktop: "none", api: "none", backend: "none" },
          "grown",
        );
        await generate(plan, { verbose: false });
        await stitch(plan);
        await verify(plan, { verbose: false });
        const root = plan.targetDir;

        // `groot add <framework>` — composed exactly as commands/add.ts does.
        const addOnce = async (framework: string, path?: string) => {
          const loaded = await loadManifest(root);
          const resolution = await resolveAddScaffold(
            loaded.manifest,
            loaded.workspaceRoot,
            framework,
            path,
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

        // A second web scaffold via --path: the REAL create-react-router.
        // next(3000) + elysia(3001) + rr(5173) — no collisions here.
        const rr = await addOnce("react-router", "apps/admin");
        expect(rr.warnings).toEqual([]);
        expect(existsSync(join(root, "apps/admin/react-router.config.ts"))).toBe(true);
        expect(existsSync(join(root, "apps/admin/.git"))).toBe(false);
        const adminPkg = JSON.parse(await readFile(join(root, "apps/admin/package.json"), "utf8"));
        expect(adminPkg.name).toBe("admin");

        // Desktop slot: the REAL create-tauri-app grows apps/desktop.
        await addOnce("tauri");
        expect(existsSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"))).toBe(true);
        expect(existsSync(join(root, "apps/desktop/package.json"))).toBe(true);
        const tauriConf = JSON.parse(
          await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
        );
        // The template pins its Vite dev server to 1420 (strictPort) and couples
        // devUrl to it — groot keeps that port (unique in the matrix).
        expect(JSON.stringify(tauriConf)).toContain("1420");
        const desktopPkg = JSON.parse(
          await readFile(join(root, "apps/desktop/package.json"), "utf8"),
        );
        expect(desktopPkg.name).toBe("desktop"); // stitchAppNames covers new slots

        // No add left a nested repo inside its scaffold (engine scrub).
        expect(existsSync(join(root, "apps/api/.git"))).toBe(false);
        expect(existsSync(join(root, "packages/backend/.git"))).toBe(false);
        expect(existsSync(join(root, "apps/desktop/.git"))).toBe(false);

        // groot.json grew to five scaffolds and kept its provenance.
        const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
        expect(manifest.scaffolds).toHaveLength(5);
        expect(manifest.scaffolds.map((s: { slot: string }) => s.slot).sort()).toEqual([
          "api",
          "backend",
          "desktop",
          "web",
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

describe.skipIf(!e2e)("scenario 4: nuxt web + add vite + add fastify (real generators)", () => {
  test(
    "plants a nuxt workspace, then grows a vite SPA and a fastify api",
    async () => {
      const plan = await planFor(
        { web: "nuxt", mobile: "none", desktop: "none", api: "none", backend: "none" },
        "vueshop",
      );
      await generate(plan, { verbose: false });
      await stitch(plan);
      await verify(plan, { verbose: false });
      const root = plan.targetDir;

      // The REAL create-nuxt grew apps/web (template via the nuxt/starter registry).
      expect(existsSync(join(root, "apps/web/nuxt.config.ts"))).toBe(true);
      expect(existsSync(join(root, "apps/web/.git"))).toBe(false);
      const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
      expect(webPkg.name).toBe("web");
      // nuxt build → .output/ is turbo-cached.
      const turbo = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
      expect(turbo.tasks.build.outputs).toContain(".output/**");

      // The REAL create-vite grows a second web scaffold — nuxt(3000) + vite(5173).
      const loaded = await loadManifest(root);
      const resolution = await resolveAddScaffold(
        loaded.manifest,
        loaded.workspaceRoot,
        "vite",
        "apps/landing",
      );
      expect(resolution.warnings).toEqual([]);
      const addPlan = buildAddPlan(
        loaded,
        resolution.scaffold,
        await readRootPackageName(loaded.workspaceRoot),
        { install: false, keepFailed: false, verbose: false },
      );
      await executeAdd(addPlan, resolution.scaffold, { verbose: false });

      expect(existsSync(join(root, "apps/landing/vite.config.ts"))).toBe(true);
      // create-vite ships _gitignore renamed on copy — the real file must exist.
      expect(existsSync(join(root, "apps/landing/.gitignore"))).toBe(true);
      expect(existsSync(join(root, "apps/landing/.git"))).toBe(false);
      const landingPkg = JSON.parse(
        await readFile(join(root, "apps/landing/package.json"), "utf8"),
      );
      expect(landingPkg.name).toBe("landing");

      // The REAL fastify-cli generate grows the api slot — nuxt(3000) +
      // vite(5173) + fastify(3001), no collisions.
      const loaded2 = await loadManifest(root);
      const fastifyRes = await resolveAddScaffold(
        loaded2.manifest,
        loaded2.workspaceRoot,
        "fastify",
        undefined,
      );
      expect(fastifyRes.warnings).toEqual([]);
      const fastifyPlan = buildAddPlan(
        loaded2,
        fastifyRes.scaffold,
        await readRootPackageName(loaded2.workspaceRoot),
        { install: false, keepFailed: false, verbose: false },
      );
      await executeAdd(fastifyPlan, fastifyRes.scaffold, { verbose: false });

      // The template structure landed: autoload app plugin, routes, plugins.
      expect(existsSync(join(root, "apps/api/src/app.ts"))).toBe(true);
      expect(existsSync(join(root, "apps/api/src/routes/root.ts"))).toBe(true);
      // fastify-cli ships __gitignore, renamed on copy by generify.
      expect(existsSync(join(root, "apps/api/.gitignore"))).toBe(true);
      expect(existsSync(join(root, "apps/api/.git"))).toBe(false);
      // groot's bun-native server entry overlays the template.
      const server = await readFile(join(root, "apps/api/src/server.ts"), "utf8");
      expect(server).toContain("port: 3001 }");
      // `npm init -y` named the package from the basename; stitch keeps "api".
      const apiPkg = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));
      expect(apiPkg.name).toBe("api");
      expect(apiPkg.dependencies["fastify-cli"]).toBeDefined();
      // Stitch swapped the Node-centric template scripts for the bun set.
      expect(apiPkg.scripts.dev).toBe("bun --watch src/server.ts");
      expect(JSON.stringify(apiPkg.scripts)).not.toContain("npm run");
      // Fastify's tsc build lands in dist/, which turbo now caches.
      const turboFinal = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
      expect(turboFinal.tasks.build.outputs).toContain("dist/**");

      const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
      expect(manifest.scaffolds).toHaveLength(3);
      expect(manifest.scaffolds.map((s: { slot: string }) => s.slot).sort()).toEqual([
        "api",
        "web",
        "web",
      ]);
      const checks = await runDoctor(await loadManifest(root));
      const failures = checks.filter((check) => check.status === "fail");
      expect(isHealthy(checks), JSON.stringify(failures, null, 2)).toBe(true);
    },
    TIMEOUT_MS,
  );
});
