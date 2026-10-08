/**
 * Add-capability planner: "add auth to the api" → one previewable operation.
 *
 * Resolve requirements and conflicts with the solver (refusals happen here,
 * before anything is written), let each selected recipe contribute its
 * actions through the shared PlanBuilder, install dependencies once, run
 * recipe post-install steps, then record the result in groot.json
 * (capabilities, environment contracts, verification, decisions) and
 * groot.lock.json (exact versions + owned artifacts) — both as exact-preview
 * edits guarded by the hashes the plan was computed against.
 */

import { listRecipes } from "../capabilities/registry.ts";
import { type CapabilityRequest, solve } from "../capabilities/solver.ts";
import type { BlueprintCapability, BlueprintV2 } from "../contracts/blueprint.ts";
import type { SolverRefusal } from "../contracts/capability.ts";
import type {
  Decision,
  EnvVarContract,
  Sha256,
  VerificationContract,
} from "../contracts/common.ts";
import type { BlockedDecision } from "../contracts/envelope.ts";
import type { GrootLock, RecipeLock } from "../contracts/lock.ts";
import type { JsonOp, OperationPlan } from "../contracts/plan.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { assertEnvContracts } from "../env.ts";
import { GrootV2Error } from "../errors.ts";
import type { Recipe, RecipeOptions } from "../recipes/types.ts";
import { type CoreContext, createdWith } from "../runtime.ts";
import { PlanBuilder } from "./builder.ts";
import { planLockUpdate } from "./lock-edit.ts";

export interface AddCapabilityInput {
  readonly root: string;
  readonly blueprint: BlueprintV2;
  readonly blueprintSha: Sha256;
  readonly lock: GrootLock;
  readonly observation: ProjectObservation;
  readonly requested: readonly CapabilityRequest[];
  readonly options?: RecipeOptions;
  readonly allowExperimental?: boolean;
  /** Recipe catalog (defaults to the registry). */
  readonly recipes?: readonly Recipe[];
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

const MAX_HINTS = 6;

/** What a choice is made against: the request as given, and the recipe catalog. */
interface ChoiceContext {
  readonly requested: readonly CapabilityRequest[];
  readonly catalog: readonly Recipe[];
}

/**
 * How to choose a recipe for `capability`. `groot plan add` gives its one
 * --recipe to the first capability it names, so a choice for any other — a
 * dependency, or a capability named later — names that capability first; and
 * when another capability already carries the flag, the choice is planned and
 * applied on its own first. (MCP sets `recipe` on that capability's entry.)
 */
function recipeResolution(capability: string, requested: readonly CapabilityRequest[]): string {
  if (requested[0]?.capability === capability) return "--recipe <id>";
  const targets = new Set(requested.map((request) => request.target ?? null));
  const [shared] = targets;
  const target = targets.size === 1 && shared ? ` --target ${shared}` : "";
  const others = [...new Set(requested.map((request) => request.capability))].filter(
    (name) => name !== capability,
  );
  if (requested.some((request) => request.capability !== capability && request.recipe)) {
    return `groot plan add ${capability}${target} --recipe <id>, apply it, then plan ${others.join(",")} again`;
  }
  return `groot plan add ${[capability, ...others].join(",")}${target} --recipe <id>`;
}

/** The value an alternative chooses ("--recipe data.a" → "data.a"). */
const chosen = (alternative: string): string => alternative.replace(/^--\w+ /, "");

/**
 * An ambiguous-choice refusal as the decision that resolves it. The solver
 * lists the choices as "--target <app>" or "--recipe <id>" alternatives; every
 * recipe of one choice supplies the same capability.
 */
function choiceDecision(
  refusal: SolverRefusal,
  index: number,
  context: ChoiceContext,
): BlockedDecision {
  const byRecipe = refusal.alternatives.every((entry) => entry.startsWith("--recipe "));
  const first = chosen(refusal.alternatives[0] ?? "");
  const capability = byRecipe
    ? context.catalog.find((recipe) => recipe.descriptor.id === first)?.descriptor.capability
    : undefined;
  return {
    id: `choice.${index + 1}`,
    kind: "decision",
    question: refusal.message,
    options: refusal.alternatives.map((alternative) => {
      const value = chosen(alternative);
      return {
        id: value,
        label: alternative,
        effect: byRecipe ? `plan ${capability ?? "it"} with ${value}` : `plan it for ${value}`,
        recommended: false,
      };
    }),
    resolveWith: !byRecipe
      ? "--target <app>"
      : capability === undefined
        ? "--recipe <id>"
        : recipeResolution(capability, context.requested),
  };
}

/** A bare flag lists its choices; a command is the resolution itself. */
function choiceHint(blocked: readonly BlockedDecision[]): string {
  return blocked
    .flatMap((decision) =>
      decision.resolveWith.startsWith("--")
        ? decision.options.map((option) => option.label)
        : [decision.resolveWith],
    )
    .slice(0, MAX_HINTS)
    .join(" · ");
}

function refusalError(refusals: readonly SolverRefusal[], context: ChoiceContext): GrootV2Error {
  const message = refusals.map((refusal) => refusal.message).join(" ");
  // A missing choice (several apps or recipes fit) is not an incompatibility:
  // it is blocked on a decision that --target or --recipe resolves (exit 7).
  if (refusals.every((refusal) => refusal.code === "ambiguous-choice")) {
    const blocked = refusals.map((refusal, index) => choiceDecision(refusal, index, context));
    return new GrootV2Error("GROOT_E_BLOCKED", message, {
      hint: choiceHint(blocked),
      details: { refusals },
      blocked,
    });
  }
  const hint = refusals
    .flatMap((refusal) => refusal.alternatives)
    .slice(0, MAX_HINTS)
    .join(" · ");
  const unknown = refusals.every(
    (refusal) => refusal.code === "unknown-capability" || refusal.code === "unknown-recipe",
  );
  return new GrootV2Error(
    unknown ? "GROOT_E_UNKNOWN_CAPABILITY" : "GROOT_E_INCOMPATIBLE",
    message,
    {
      hint,
      details: { refusals },
    },
  );
}

function appendAll(pointer: string, values: readonly unknown[]): JsonOp[] {
  return values.map((value) => ({ op: "append-unique" as const, pointer, value }));
}

export async function planAddCapability(
  ctx: CoreContext,
  input: AddCapabilityInput,
): Promise<OperationPlan> {
  const { blueprint, observation } = input;
  const result = solve({
    requested: input.requested,
    blueprint,
    observation,
    allowExperimental: input.allowExperimental,
    recipes: input.recipes,
  });
  const catalog = input.recipes ?? listRecipes();
  if (!result.ok) throw refusalError(result.refusals, { requested: input.requested, catalog });

  const pending = result.selections.filter((selection) => !selection.alreadySatisfied);
  const names = input.requested.map((request) => request.capability).join(" + ");
  const builder = new PlanBuilder({
    root: input.root,
    intent: {
      type: "add-capability",
      capabilities: input.requested.map((request) => request.capability),
      target: input.requested[0]?.target ?? null,
      recipe: input.requested[0]?.recipe ?? null,
      options: { ...(input.options ?? {}) },
    },
    summary:
      pending.length === 0
        ? `${names}: already present — nothing to change`
        : `add ${pending.map((selection) => `${selection.capability} (${selection.recipe}) to ${selection.target}`).join(", ")}`,
    topology: blueprint.project.topology,
    revision: {
      vcs: observation.git.vcs,
      head: observation.git.head,
      branch: observation.git.branch,
      dirty: observation.git.dirty,
      worktreeFingerprint: observation.git.worktreeFingerprint,
    },
    createdWith: createdWith(),
    dirtyPaths: new Set([
      ...observation.git.staged,
      ...observation.git.unstaged,
      ...observation.git.untracked,
    ]),
  });
  builder.capabilities(result);
  builder.precondition({ type: "manifest", state: "v2", sha256: input.blueprintSha });

  const capabilities: BlueprintCapability[] = [];
  const environment: EnvVarContract[] = [];
  const verification: VerificationContract[] = [];
  const decisions: Decision[] = [];
  const locks: RecipeLock[] = [];
  const shared = new Map<string, unknown>();
  const postInstall: Parameters<PlanBuilder["add"]>[0][] = [];

  for (const selection of pending) {
    const recipe = catalog.find((entry) => entry.descriptor.id === selection.recipe);
    const app = blueprint.apps.find((entry) => entry.id === selection.target);
    if (recipe === undefined || app === undefined) {
      throw new GrootV2Error(
        "GROOT_E_INTERNAL",
        `solver selected ${selection.recipe} on ${selection.target}, which is not registered`,
      );
    }
    ctx.events.emit({
      type: "plan.recipe",
      level: "info",
      message: `planning ${recipe.descriptor.id} on ${app.path}`,
    });
    const contribution = await recipe.plan({
      ctx,
      root: input.root,
      builder,
      blueprint,
      observation,
      target: { app, unit: observation.units.find((unit) => unit.path === app.path) },
      options: input.options ?? {},
      earlier: result.selections.slice(0, result.selections.indexOf(selection)),
      shared,
    });
    assertEnvContracts(contribution.env);
    capabilities.push(contribution.capability);
    environment.push(...contribution.env);
    verification.push(...contribution.verification);
    decisions.push(...contribution.decisions);
    locks.push(contribution.lock);
    postInstall.push(...(contribution.postInstall ?? []));
    for (const contract of contribution.env) builder.env(contract);
    for (const contract of contribution.verification) builder.verify(contract);
    for (const artifact of contribution.lock.artifacts) {
      builder.own({
        path: artifact.path,
        owner: artifact.ownership === "file" ? "groot" : "shared",
        parts: artifact.parts,
        note: `${recipe.descriptor.id} ${artifact.ownership === "file" ? "owns this file" : `owns ${artifact.parts.join(", ")}`}`,
      });
    }
  }

  if (pending.length === 0) return builder.build();

  const dependencyChanges = builder.build().dependencies;
  if (dependencyChanges.length > 0) {
    builder.add({
      type: "command.run",
      argv: ["bun", "install"],
      cwd: ".",
      purpose: "install",
      network: true,
      idempotent: true,
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: {},
      stdin: null,
      touches: ["bun.lock"],
      description: `install ${dependencyChanges.length} dependency change(s) (bun install at the workspace root)`,
      classes: ["install", "network", "command"],
      reversible: true,
      compensation: "restore package.json and bun.lock from backup, then re-run bun install",
    });
  }
  for (const draft of postInstall) builder.add(draft);

  await builder.editFile({
    path: "groot.json",
    edit: {
      kind: "json",
      ops: [
        ...appendAll("/capabilities", capabilities),
        ...appendAll("/environment", environment),
        ...appendAll("/verification", verification),
        ...appendAll("/decisions", decisions),
      ],
    },
    description: `record ${capabilities.map((entry) => entry.id).join(", ")} in groot.json (capabilities, environment contracts, verification, decisions)`,
    owns: ["/capabilities", "/environment", "/verification", "/decisions"],
    createIfMissing: false,
  });
  await planLockUpdate(
    builder,
    input.lock,
    appendAll("/recipes", locks),
    "record exact recipe versions, dependencies, and owned artifacts in groot.lock.json",
    ["/recipes"],
  );
  builder.own({
    path: "groot.json",
    owner: "groot",
    parts: [],
    note: "blueprint — change it through plans",
  });
  builder.own({
    path: "groot.lock.json",
    owner: "groot",
    parts: [],
    note: "lock — change it through plans",
  });
  builder.setRecovery({
    mode: "full",
    summary:
      "Rollback restores every file Groot wrote or edited (refused for files you edited afterwards) and re-runs bun install to resync node_modules.",
    irreversible: [],
    limits: [
      "Local development databases created later by db:migrate are not deleted by rollback.",
      "Generated secrets are removed with the env file only if it is unchanged since apply.",
    ],
  });
  return builder.build();
}
