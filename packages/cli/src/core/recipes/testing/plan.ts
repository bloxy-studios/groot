/**
 * Test-only planning harness (never imported by runtime code): drives recipes
 * through one PlanBuilder exactly like the add-capability planner does —
 * requirements first, one shared `shared` map, contributions' env and
 * verification contracts registered on the builder — and derives the
 * blueprint and lock the apply step records, so tests and the certification
 * suite can verify a materialized plan against real files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintApp, BlueprintV2 } from "../../contracts/blueprint.ts";
import type { SolverSelection } from "../../contracts/capability.ts";
import { schemaUrl } from "../../contracts/common.ts";
import type { GrootLock } from "../../contracts/lock.ts";
import type { OperationPlan } from "../../contracts/plan.ts";
import type { ProjectObservation } from "../../contracts/project.ts";
import { gitState } from "../../git.ts";
import { PlanBuilder } from "../../planner/builder.ts";
import { createContext, createdWith } from "../../runtime.ts";
import { fixtureFact, observationFixture, unitFixture } from "../../test-fixtures.ts";
import type { Recipe, RecipeContribution } from "../types.ts";

export interface PlannedRecipes {
  readonly plan: OperationPlan;
  readonly contributions: readonly RecipeContribution[];
}

export interface PlanRecipesInput {
  readonly root: string;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation;
  readonly app: BlueprintApp;
  /** In application order (data before auth). */
  readonly recipes: readonly Recipe[];
}

function selection(recipe: Recipe, app: BlueprintApp, last: boolean): SolverSelection {
  return {
    capability: recipe.descriptor.capability,
    recipe: recipe.descriptor.id,
    recipeVersion: recipe.descriptor.version,
    target: app.id,
    reason: last ? "requested" : "dependency",
    alreadySatisfied: false,
  };
}

function builderFor(input: PlanRecipesInput, selections: readonly SolverSelection[]): PlanBuilder {
  const { git } = input.observation;
  return new PlanBuilder({
    root: input.root,
    intent: {
      type: "add-capability",
      capabilities: [input.recipes.at(-1)?.descriptor.capability ?? "data"],
      target: input.app.id,
      recipe: null,
      options: {},
    },
    summary: `add ${selections.map((entry) => `${entry.capability} (${entry.recipe})`).join(", ")} to ${input.app.id}`,
    topology: input.blueprint.project.topology,
    revision: {
      vcs: git.vcs,
      head: git.head,
      branch: git.branch,
      dirty: git.dirty,
      worktreeFingerprint: git.worktreeFingerprint,
    },
    createdWith: createdWith(),
    dirtyPaths: new Set([...git.staged, ...git.unstaged, ...git.untracked]),
  });
}

export async function planRecipes(input: PlanRecipesInput): Promise<PlannedRecipes> {
  const { observation, app } = input;
  const selections = input.recipes.map((recipe, index) =>
    selection(recipe, app, index === input.recipes.length - 1),
  );
  const builder = builderFor(input, selections);
  builder.capabilities({ ok: true, selections, refusals: [] });
  const shared = new Map<string, unknown>();
  const contributions: RecipeContribution[] = [];
  for (const [index, recipe] of input.recipes.entries()) {
    const contribution = await recipe.plan({
      ctx: createContext({ cwd: input.root }),
      root: input.root,
      builder,
      blueprint: input.blueprint,
      observation,
      target: { app, unit: observation.units.find((unit) => unit.path === app.path) },
      options: {},
      earlier: selections.slice(0, index),
      shared,
    });
    for (const contract of contribution.env) builder.env(contract);
    for (const contract of contribution.verification) builder.verify(contract);
    contributions.push(contribution);
  }
  return { plan: builder.build(), contributions };
}

/** groot.json after the plan applied (what add-capability records). */
export function blueprintWith(
  blueprint: BlueprintV2,
  contributions: readonly RecipeContribution[],
): BlueprintV2 {
  return {
    ...blueprint,
    capabilities: [...blueprint.capabilities, ...contributions.map((entry) => entry.capability)],
    environment: [...blueprint.environment, ...contributions.flatMap((entry) => entry.env)],
    verification: [
      ...blueprint.verification,
      ...contributions.flatMap((entry) => entry.verification),
    ],
    decisions: [...blueprint.decisions, ...contributions.flatMap((entry) => entry.decisions)],
  };
}

/** groot.lock.json after the plan applied. */
export function lockWith(contributions: readonly RecipeContribution[]): GrootLock {
  return {
    $schema: schemaUrl("lock"),
    lockVersion: 1,
    generatedBy: createdWith(),
    generators: [],
    recipes: contributions.map((entry) => entry.lock),
    context: [],
  };
}

/**
 * A project observation for a real directory: the unit's manifest facts as
 * discovery would report them (entry relative to the unit), plus the actual
 * git state so dirty paths are flagged in the plan.
 */
export async function observeUnit(
  root: string,
  app: BlueprintApp,
  topology: "single" | "monorepo",
): Promise<ProjectObservation> {
  const manifestPath = join(root, app.path === "." ? "" : app.path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const unit = unitFixture({
    path: app.path,
    entry: fixtureFact(app.entry),
    scripts: manifest.scripts ?? {},
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
  });
  const observation = observationFixture([unit], root);
  return {
    ...observation,
    topology: fixtureFact(topology),
    git: await gitState(root),
  };
}
