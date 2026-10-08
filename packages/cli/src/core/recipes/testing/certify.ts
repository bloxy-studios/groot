/**
 * Certification driver (test-only; never imported by runtime code). For one
 * project it does what `groot add auth` will do end to end, with the pieces
 * available in this unit: plan data + auth through one PlanBuilder, validate
 * the plan contract, materialize it (testing/apply.ts stands in for the
 * executor), record groot.json + groot.lock.json, run the real `bun install`,
 * then run every verification profile — structural, build, runtime,
 * product-flow — with the recipes' contracts plus Groot's defaults.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintApp, BlueprintV2 } from "../../contracts/blueprint.ts";
import type { VerificationReport } from "../../contracts/evidence.ts";
import { OperationPlan } from "../../contracts/plan.ts";
import { prettyJson } from "../../json.ts";
import { runProcess, tail } from "../../process.ts";
import { createContext } from "../../runtime.ts";
import { blueprintFixture } from "../../test-fixtures.ts";
import { defaultContracts, registerBuiltInCheckers } from "../../verify/checkers.ts";
import { runVerification } from "../../verify/engine.ts";
import { authBetterAuth } from "../auth/recipe.ts";
import { dataDrizzleSqlite } from "../data/recipe.ts";
import { registerRecipeCheckers } from "../index.ts";
import { materializePlan } from "./apply.ts";
import { blueprintWith, lockWith, observeUnit, planRecipes } from "./plan.ts";

export interface CertificationCase {
  readonly name: string;
  /** Project root (where groot.json lives and `bun install` runs). */
  readonly root: string;
  readonly topology: "single" | "monorepo";
  readonly app: BlueprintApp;
  readonly origin: "created" | "adopted";
}

export interface CertificationResult {
  readonly name: string;
  readonly plan: OperationPlan;
  readonly blueprint: BlueprintV2;
  readonly report: VerificationReport;
  readonly generatedSecrets: readonly string[];
  readonly timings: Readonly<Record<string, number>>;
}

const INSTALL_TIMEOUT_MS = 600_000;

function since(started: number): number {
  return Math.round(performance.now() - started);
}

export async function certify(c: CertificationCase): Promise<CertificationResult> {
  registerBuiltInCheckers();
  registerRecipeCheckers();
  const timings: Record<string, number> = {};
  let started = performance.now();
  const base = blueprintFixture({
    project: { name: c.name, topology: c.topology, packageManager: "bun", origin: c.origin },
    apps: [c.app],
  });
  const observation = await observeUnit(c.root, c.app, c.topology);
  const { plan, contributions } = await planRecipes({
    root: c.root,
    blueprint: base,
    observation,
    app: c.app,
    recipes: [dataDrizzleSqlite, authBetterAuth],
  });
  OperationPlan.parse(plan);
  timings.planMs = since(started);

  started = performance.now();
  const materialized = await materializePlan(c.root, plan);
  const blueprint = blueprintWith(base, contributions);
  const lock = lockWith(contributions);
  writeFileSync(join(c.root, "groot.json"), prettyJson(blueprint));
  writeFileSync(join(c.root, "groot.lock.json"), prettyJson(lock));
  timings.applyMs = since(started);

  started = performance.now();
  const install = await runProcess({
    argv: ["bun", "install"],
    cwd: c.root,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `bun install failed in ${c.root}: ${tail(`${install.stdout}\n${install.stderr}`, 10)}`,
    );
  }
  timings.installMs = since(started);

  started = performance.now();
  const report = await runVerification(createContext({ cwd: c.root }), {
    root: c.root,
    blueprint,
    observation: null,
    lock,
    profiles: ["structural", "build", "runtime", "product-flow"],
    extra: defaultContracts(blueprint),
  });
  timings.verifyMs = since(started);
  return {
    name: c.name,
    plan,
    blueprint,
    report,
    generatedSecrets: materialized.secrets,
    timings,
  };
}
