/**
 * registerBuiltInRecipes()/registerRecipeCheckers() wired into the real
 * capability registry, verification engine, and compatibility solver.
 *
 * Runs in a child process: Bun shares module state across test files, and
 * registering the real recipes into the global registry would change what
 * other suites' solver calls pick.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolverResult } from "../contracts/capability.ts";
import { RECIPE_SUPPORT } from "./versions.ts";

const core = join(import.meta.dir, "..");

const PROBE = `
import { registerBuiltInRecipes, registerRecipeCheckers } from ${JSON.stringify(join(core, "recipes/index.ts"))};
import { getCapability, listRecipes } from ${JSON.stringify(join(core, "capabilities/registry.ts"))};
import { solve } from ${JSON.stringify(join(core, "capabilities/solver.ts"))};
import { hasChecker } from ${JSON.stringify(join(core, "verify/engine.ts"))};
import { appFixture, blueprintFixture, observationFixture, unitFixture } from ${JSON.stringify(join(core, "test-fixtures.ts"))};

registerBuiltInRecipes();
registerBuiltInRecipes(); // idempotent
registerRecipeCheckers();
const blueprint = blueprintFixture();
const unit = (dependencies) => observationFixture([unitFixture({ path: "apps/api", dependencies })]);
const auth = (dependencies, extra = {}) =>
  solve({ requested: [{ capability: "auth" }], blueprint, observation: unit(dependencies), allowExperimental: true, ...extra });
console.log(JSON.stringify({
  recipes: listRecipes().map((recipe) => recipe.descriptor.id),
  capabilities: { data: getCapability("data").recipes, auth: getCapability("auth").recipes },
  checkers: ["structural.recipe", "build.bundle", "runtime.http", "auth.flow"].filter(hasChecker),
  auth: auth({ hono: "^4.13.13" }),
  certifiedOnly: auth({ hono: "^4.13.13" }, { allowExperimental: false }),
  prisma: auth({ hono: "^4.13.13", prisma: "^6.0.0" }),
  nextAuth: auth({ hono: "^4.13.13", "next-auth": "^5.0.0" }),
  jsEntry: solve({
    requested: [{ capability: "data" }],
    blueprint: blueprintFixture({ apps: [appFixture({ id: "api", path: "apps/api", entry: "src/index.js" })] }),
    observation: unit({ hono: "^4.13.13" }),
    allowExperimental: true,
  }),
}));
`;

interface ProbeOutput {
  recipes: string[];
  capabilities: { data: string[]; auth: string[] };
  checkers: string[];
  auth: SolverResult;
  certifiedOnly: SolverResult;
  prisma: SolverResult;
  nextAuth: SolverResult;
  jsEntry: SolverResult;
}

let cached: Promise<ProbeOutput> | undefined;

/** One child process serves both tests. */
function probe(): Promise<ProbeOutput> {
  cached ??= runProbe();
  return cached;
}

async function runProbe(): Promise<ProbeOutput> {
  const dir = mkdtempSync(join(tmpdir(), "groot-registry-probe-"));
  const script = join(dir, "probe.ts");
  writeFileSync(script, PROBE);
  const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`registry probe failed (exit ${code}): ${stderr}`);
  return JSON.parse(stdout) as ProbeOutput;
}

describe("built-in registration + solver", () => {
  test("registers both recipes and their checkers; auth requires data, so data is planned first", async () => {
    // Act
    const out = await probe();
    // Assert
    expect(out.recipes).toEqual(["data.drizzle-sqlite", "auth.better-auth"]);
    expect(out.capabilities).toEqual({ data: ["data.drizzle-sqlite"], auth: ["auth.better-auth"] });
    expect(out.checkers).toEqual([
      "structural.recipe",
      "build.bundle",
      "runtime.http",
      "auth.flow",
    ]);
    expect(out.auth.ok).toBe(true);
    expect(out.auth.selections.map((s) => [s.capability, s.recipe, s.target, s.reason])).toEqual([
      ["data", "data.drizzle-sqlite", "api", "dependency"],
      ["auth", "auth.better-auth", "api", "requested"],
    ]);
    // Without --experimental the solver only accepts certified recipes.
    expect(out.certifiedOnly.ok).toBe(RECIPE_SUPPORT === "certified");
  }, 60_000);

  test("an existing ORM or auth library refuses the plan with the conflicting package named", async () => {
    // Act
    const out = await probe();
    // Assert
    expect(out.prisma.ok).toBe(false);
    expect(out.prisma.refusals[0]?.code).toBe("dependency-conflict");
    expect(out.prisma.refusals[0]?.message).toContain("already depends on prisma");
    expect(out.nextAuth.refusals.map((r) => r.code)).toEqual(["dependency-conflict"]);
    expect(out.nextAuth.refusals[0]?.message).toContain("next-auth");
    expect(out.jsEntry.refusals[0]?.message).toContain("is not TypeScript");
  }, 60_000);
});
