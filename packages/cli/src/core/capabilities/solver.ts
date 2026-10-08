/**
 * Compatibility solver: turns requested capabilities into an ordered list of
 * recipe applications (requirements first), or refuses at PLANNING time with
 * a precise reason and alternatives — before anything is written.
 *
 * Inputs are the blueprint (desired state: which apps exist, which
 * capabilities are already recorded) and the observation (actual
 * dependencies, so e.g. an existing auth library blocks a second auth setup).
 */
import type { BlueprintApp, BlueprintV2 } from "../contracts/blueprint.ts";
import type { SolverRefusal, SolverResult, SolverSelection } from "../contracts/capability.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import type { Recipe, RecipeTarget } from "../recipes/types.ts";
import { CAPABILITIES, listRecipes } from "./registry.ts";

export interface CapabilityRequest {
  readonly capability: string;
  readonly recipe?: string | null;
  /** BlueprintApp id or path. */
  readonly target?: string | null;
}

export interface SolveInput {
  readonly requested: readonly CapabilityRequest[];
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation;
  /** Permit experimental (not yet certified) recipes. */
  readonly allowExperimental?: boolean;
  /** Recipe catalog (defaults to the registry; injected by tests and future recipe sources). */
  readonly recipes?: readonly Recipe[];
}

function targetOf(app: BlueprintApp, observation: ProjectObservation): RecipeTarget {
  return { app, unit: observation.units.find((unit) => unit.path === app.path) };
}

/** Why `recipe` cannot apply to `app` (empty = compatible). */
export function recipeFit(
  recipe: Recipe,
  app: BlueprintApp,
  blueprint: BlueprintV2,
  observation: ProjectObservation,
): string[] {
  const { targets } = recipe.descriptor;
  const reasons: string[] = [];
  if (!targets.kinds.includes(app.kind)) {
    reasons.push(
      `${app.id} is a ${app.kind} app; ${recipe.descriptor.id} targets ${targets.kinds.join("/")} apps`,
    );
  }
  if (
    targets.frameworks.length > 0 &&
    (app.framework === null || !targets.frameworks.includes(app.framework))
  ) {
    reasons.push(
      `${app.id} uses ${app.framework ?? "an unknown framework"}; ${recipe.descriptor.id} is certified for ${targets.frameworks.join(", ")}`,
    );
  }
  if (!targets.topologies.includes(blueprint.project.topology)) {
    reasons.push(
      `${recipe.descriptor.id} is not certified for ${blueprint.project.topology} projects`,
    );
  }
  return [...reasons, ...recipe.compatibility(targetOf(app, observation), observation)];
}

function findApp(blueprint: BlueprintV2, ref: string): BlueprintApp | undefined {
  return blueprint.apps.find((app) => app.id === ref || app.path === ref);
}

interface Resolution {
  readonly selections: SolverSelection[];
  readonly refusals: SolverRefusal[];
}

/**
 * Choose recipe + target for one capability. `forcedTarget` pins
 * requirements to the dependent's app (auth on apps/api → data on apps/api);
 * `dependent` is the recipe that requires it when nothing requests it.
 */
function resolveOne(
  request: CapabilityRequest,
  input: SolveInput,
  forcedTarget: BlueprintApp | null,
  dependent: Recipe | null,
): { recipe: Recipe; app: BlueprintApp } | SolverRefusal {
  const { blueprint, observation } = input;
  const capability = CAPABILITIES.find((entry) => entry.id === request.capability);
  if (capability === undefined) {
    return {
      code: "unknown-capability",
      message: `Unknown capability "${request.capability}".`,
      alternatives: CAPABILITIES.map((entry) => entry.id),
    };
  }
  const catalog = input.recipes ?? listRecipes();
  const candidates = catalog.filter((recipe) => recipe.descriptor.capability === capability.id);
  let pool = candidates;
  if (request.recipe) {
    const named = catalog.find((recipe) => recipe.descriptor.id === request.recipe);
    if (named === undefined || named.descriptor.capability !== capability.id) {
      return {
        code: "unknown-recipe",
        message: `No recipe "${request.recipe}" supplies ${capability.id}.`,
        alternatives: candidates.map((recipe) => recipe.descriptor.id),
      };
    }
    pool = [named];
  }
  if (!input.allowExperimental) {
    const certified = pool.filter((recipe) => recipe.descriptor.support === "certified");
    if (certified.length === 0) {
      return {
        code: "not-certified",
        message: `No certified recipe supplies ${capability.id}${request.recipe ? ` (${request.recipe} is ${pool[0]?.descriptor.support})` : ""}.`,
        alternatives: pool.map(
          (recipe) => `${recipe.descriptor.id} (${recipe.descriptor.support}; pass --experimental)`,
        ),
      };
    }
    pool = certified;
  }

  let apps: BlueprintApp[];
  if (forcedTarget !== null) {
    apps = [forcedTarget];
  } else if (request.target) {
    const app = findApp(blueprint, request.target);
    if (app === undefined) {
      return {
        code: "no-compatible-target",
        message: `No app "${request.target}" in groot.json.`,
        alternatives: blueprint.apps.map((entry) => `${entry.id} (${entry.path})`),
      };
    }
    apps = [app];
  } else {
    apps = blueprint.apps;
  }

  const fits: { recipe: Recipe; app: BlueprintApp }[] = [];
  const reasons: string[] = [];
  for (const app of apps) {
    for (const recipe of pool) {
      const why = recipeFit(recipe, app, blueprint, observation);
      if (why.length === 0) fits.push({ recipe, app });
      else reasons.push(...why);
    }
  }
  if (fits.length === 0) {
    return {
      code: "no-compatible-target",
      message: `${capability.title} cannot be added: ${[...new Set(reasons)].join("; ") || "no apps in groot.json"}.`,
      alternatives: pool.map(
        (recipe) =>
          `${recipe.descriptor.id} needs a ${recipe.descriptor.targets.kinds.join("/")} app using ${recipe.descriptor.targets.frameworks.join(" or ") || "any framework"}`,
      ),
    };
  }
  const distinctApps = [...new Set(fits.map((fit) => fit.app.id))];
  if (distinctApps.length > 1) {
    return {
      code: "ambiguous-choice",
      message: `${capability.title} fits several apps (${distinctApps.join(", ")}); choose one with --target.`,
      alternatives: distinctApps.map((id) => `--target ${id}`),
    };
  }
  // The app already records the capability: that recipe is the answer (reported
  // as already satisfied), not a choice between recipes.
  const recorded = blueprint.capabilities.find(
    (entry) => entry.id === capability.id && entry.target === distinctApps[0],
  );
  const kept = fits.find((fit) => fit.recipe.descriptor.id === recorded?.recipe);
  if (kept !== undefined) return kept;
  // Never pick silently between recipes that could both supply the capability.
  const distinctRecipes = [...new Set(fits.map((fit) => fit.recipe.descriptor.id))];
  if (distinctRecipes.length > 1) {
    const choices = distinctRecipes.join(", ");
    return {
      code: "ambiguous-choice",
      // --recipe applies to a request, so a dependency's choice is made by requesting it.
      message:
        dependent === null
          ? `Several recipes supply ${capability.title.toLowerCase()} for ${distinctApps[0]} (${choices}); choose one with --recipe.`
          : `${dependent.descriptor.id} requires ${capability.id} (${capability.title.toLowerCase()}) on ${distinctApps[0]}, and several recipes supply it (${choices}); choose one by requesting ${capability.id} with --recipe.`,
      alternatives: distinctRecipes.map((id) => `--recipe ${id}`),
    };
  }
  return fits[0] as { recipe: Recipe; app: BlueprintApp };
}

/** Refusals caused by what is already present (recorded or observed). */
function presenceCheck(
  recipe: Recipe,
  app: BlueprintApp,
  input: SolveInput,
): { satisfied: boolean; refusal: SolverRefusal | null } {
  const existing = input.blueprint.capabilities.find(
    (entry) => entry.id === recipe.descriptor.capability && entry.target === app.id,
  );
  if (existing !== undefined) {
    if (existing.recipe === recipe.descriptor.id) return { satisfied: true, refusal: null };
    return {
      satisfied: false,
      refusal: {
        code: "recipe-conflict",
        message: `${app.id} already has ${existing.id} via ${existing.recipe}; Groot won't layer ${recipe.descriptor.id} on top of it.`,
        alternatives: [`keep ${existing.recipe}`],
      },
    };
  }
  const unit = input.observation.units.find((entry) => entry.path === app.path);
  const deps = { ...(unit?.dependencies ?? {}), ...(unit?.devDependencies ?? {}) };
  for (const conflict of recipe.descriptor.conflicts) {
    if (conflict.dependency !== null && conflict.dependency in deps) {
      return {
        satisfied: false,
        refusal: {
          code: "dependency-conflict",
          message: `${app.path} already depends on ${conflict.dependency}: ${conflict.reason}`,
          alternatives: [
            `remove ${conflict.dependency} from ${app.path}`,
            "keep the existing setup",
          ],
        },
      };
    }
    if (conflict.capability !== null) {
      const clash = input.blueprint.capabilities.find(
        (entry) =>
          entry.id === conflict.capability &&
          entry.target === app.id &&
          (conflict.recipe === null || entry.recipe === conflict.recipe),
      );
      if (clash !== undefined) {
        return {
          satisfied: false,
          refusal: {
            code: "recipe-conflict",
            message: `${recipe.descriptor.id} conflicts with ${clash.recipe} on ${app.id}: ${conflict.reason}`,
            alternatives: [],
          },
        };
      }
    }
  }
  return { satisfied: false, refusal: null };
}

/**
 * Declared capability/recipe conflicts between recipes planned in the same
 * solve. presenceCheck only sees what is already recorded, and runs before a
 * recipe's own requirements are chosen — so this pass runs after every
 * selection is made, and the outcome doesn't depend on request order.
 */
function plannedConflicts(
  input: SolveInput,
  selections: readonly SolverSelection[],
): SolverRefusal[] {
  const catalog = input.recipes ?? listRecipes();
  const planned = selections.filter((entry) => !entry.alreadySatisfied);
  const refusals: SolverRefusal[] = [];
  for (const selection of planned) {
    const recipe = catalog.find((entry) => entry.descriptor.id === selection.recipe);
    for (const conflict of recipe?.descriptor.conflicts ?? []) {
      if (conflict.capability === null) continue;
      const clash = planned.find(
        (other) =>
          other !== selection &&
          other.target === selection.target &&
          other.capability === conflict.capability &&
          (conflict.recipe === null || other.recipe === conflict.recipe),
      );
      if (clash !== undefined) {
        refusals.push({
          code: "recipe-conflict",
          message: `${selection.recipe} conflicts with ${clash.recipe} on ${selection.target}: ${conflict.reason}`,
          alternatives: [],
        });
      }
    }
  }
  return refusals;
}

const keyOf = (entry: SolverSelection): string => `${entry.capability}@${entry.target}`;

/** The request that names `capability` for `app` (untargeted requests name every app). */
function explicitRequest(
  input: SolveInput,
  capability: string,
  app: BlueprintApp,
): CapabilityRequest | undefined {
  return input.requested.find(
    (entry) =>
      entry.capability === capability &&
      (!entry.target || findApp(input.blueprint, entry.target)?.id === app.id),
  );
}

type Requirement = Recipe["descriptor"]["requires"][number];

/** The refusal when `supplier` (recorded, or selected in this solve) can't satisfy `requirement`. */
function requirementMismatch(
  recipe: Recipe,
  requirement: Requirement,
  app: BlueprintApp,
  supplier: { readonly recipe: string; readonly recorded: boolean },
): SolverRefusal | null {
  if (requirement.recipes.length === 0 || requirement.recipes.includes(supplier.recipe)) {
    return null;
  }
  return {
    code: "missing-requirement",
    message: `${recipe.descriptor.id} requires ${requirement.capability} via ${requirement.recipes.join(" or ")}, but ${supplier.recorded ? `${app.id} uses ${supplier.recipe}` : `${supplier.recipe} is selected for ${app.id}`}.`,
    alternatives: requirement.recipes,
  };
}

/** Satisfy one requirement of `recipe` on `app` (recorded, chosen earlier, or visited now). */
function visitRequirement(
  recipe: Recipe,
  requirement: Requirement,
  app: BlueprintApp,
  input: SolveInput,
  out: Resolution,
  visiting: Set<string>,
): void {
  const key = `${requirement.capability}@${app.id}`;
  const explicit = explicitRequest(input, requirement.capability, app);
  const reason = explicit !== undefined ? "requested" : "dependency";
  const recorded = input.blueprint.capabilities.find(
    (entry) => entry.id === requirement.capability && entry.target === app.id,
  );
  if (recorded !== undefined) {
    const mismatch = requirementMismatch(recipe, requirement, app, {
      recipe: recorded.recipe,
      recorded: true,
    });
    if (mismatch !== null) out.refusals.push(mismatch);
    else if (!out.selections.some((entry) => keyOf(entry) === key)) {
      out.selections.push({
        capability: requirement.capability,
        recipe: recorded.recipe,
        recipeVersion: recorded.recipeVersion,
        target: app.id,
        reason,
        alreadySatisfied: true,
      });
    }
    return;
  }
  const request = {
    capability: requirement.capability,
    recipe: explicit?.recipe ?? requirement.recipes[0] ?? null,
    target: app.id,
  };
  visit(request, input, app, reason, out, visiting, explicit === undefined ? recipe : null);
  // Whatever supplies the requirement — chosen earlier in this solve or named
  // by an explicit request — must be a recipe the dependent declares compatible.
  const chosen = out.selections.find((entry) => keyOf(entry) === key);
  const mismatch =
    chosen === undefined
      ? null
      : requirementMismatch(recipe, requirement, app, { recipe: chosen.recipe, recorded: false });
  if (mismatch !== null) out.refusals.push(mismatch);
}

function visit(
  request: CapabilityRequest,
  input: SolveInput,
  forcedTarget: BlueprintApp | null,
  reason: SolverSelection["reason"],
  out: Resolution,
  visiting: Set<string>,
  dependent: Recipe | null = null,
): void {
  const resolved = resolveOne(request, input, forcedTarget, dependent);
  if ("code" in resolved) {
    out.refusals.push(resolved);
    return;
  }
  const { recipe, app } = resolved;
  const key = `${recipe.descriptor.capability}@${app.id}`;
  const selected = out.selections.find((entry) => keyOf(entry) === key);
  if (selected !== undefined) {
    // A requirement's recipe constraint is checked by visitRequirement; a
    // top-level request for another recipe is a conflict, never dropped.
    if (forcedTarget === null && selected.recipe !== recipe.descriptor.id) {
      out.refusals.push({
        code: "recipe-conflict",
        message: `${app.id} already ${selected.alreadySatisfied ? "has" : "gets"} ${selected.capability} via ${selected.recipe}; Groot won't layer ${recipe.descriptor.id} on top of it.`,
        alternatives: [`keep ${selected.recipe}`],
      });
    }
    return;
  }
  if (visiting.has(key)) {
    out.refusals.push({
      code: "missing-requirement",
      message: `Circular requirement involving ${key}.`,
      alternatives: [],
    });
    return;
  }
  visiting.add(key);

  const presence = presenceCheck(recipe, app, input);
  if (presence.refusal !== null) {
    out.refusals.push(presence.refusal);
    visiting.delete(key);
    return;
  }
  if (!presence.satisfied) {
    for (const requirement of recipe.descriptor.requires) {
      visitRequirement(recipe, requirement, app, input, out, visiting);
    }
  }
  visiting.delete(key);
  out.selections.push({
    capability: recipe.descriptor.capability,
    recipe: recipe.descriptor.id,
    recipeVersion: recipe.descriptor.version,
    target: app.id,
    reason,
    alreadySatisfied: presence.satisfied,
  });
}

/**
 * Each refusal once: a capability both requested and required by another
 * request is resolved twice, and an unresolved choice would be reported twice.
 */
function distinctRefusals(refusals: readonly SolverRefusal[]): SolverRefusal[] {
  const seen = new Set<string>();
  return refusals.filter((refusal) => {
    const key = JSON.stringify([refusal.code, refusal.message, refusal.alternatives]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve requested capabilities into ordered recipe applications or refusals. */
export function solve(input: SolveInput): SolverResult {
  const out: Resolution = { selections: [], refusals: [] };
  for (const request of input.requested) {
    visit(request, input, null, "requested", out, new Set());
  }
  const refusals = distinctRefusals([...out.refusals, ...plannedConflicts(input, out.selections)]);
  return { ok: refusals.length === 0, selections: out.selections, refusals };
}
