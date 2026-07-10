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
import { generate } from "./generate.ts";
import { buildPlan } from "./plan.ts";
import type { Slot } from "./types.ts";

const e2e = process.env.GROOT_E2E === "1";
const TIMEOUT_MS = 420_000;

async function planFor(selections: Record<Slot, string>, name: string) {
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
    },
  });
}

describe.skipIf(!e2e)("generate (real generators — flagship: next + elysia + convex)", () => {
  test(
    "plants trunk, grows all scaffolds, and runs offline convex codegen",
    async () => {
      const plan = await planFor(
        { web: "next", mobile: "none", api: "elysia", backend: "convex" },
        "flagship",
      );
      const steps: string[] = [];
      await generate(plan, { verbose: false, onStep: (label) => steps.push(label) });

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

      // Convex: offline codegen materialized _generated.
      expect(existsSync(join(root, "packages/backend/convex/_generated/api.d.ts"))).toBe(true);
      expect(existsSync(join(root, "packages/backend/convex/tsconfig.json"))).toBe(true);

      expect(steps.length).toBeGreaterThanOrEqual(4);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!e2e)("generate (real generators — alt web/api: sveltekit + hono)", () => {
  test(
    "grows sveltekit and hono into the trunk",
    async () => {
      const plan = await planFor(
        { web: "sveltekit", mobile: "none", api: "hono", backend: "none" },
        "altstack",
      );
      await generate(plan, { verbose: false });

      const root = plan.targetDir;
      // sv ≥ 0.16 folds SvelteKit config into vite.config.ts (no svelte.config.js).
      const viteConfig = await readFile(join(root, "apps/web/vite.config.ts"), "utf8");
      expect(viteConfig).toContain("sveltekit(");
      expect(existsSync(join(root, "apps/web/src/routes/+page.svelte"))).toBe(true);

      const honoPkg = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));
      expect(honoPkg.dependencies.hono).toBeDefined();
      expect(existsSync(join(root, "apps/api/src/index.ts"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});
