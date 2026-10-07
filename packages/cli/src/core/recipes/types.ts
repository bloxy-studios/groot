/**
 * The executable half of the recipe contract (the data half is
 * RecipeDescriptor in core/contracts/capability.ts). A recipe checks whether
 * it can target an app, then contributes actions to a plan through the
 * PlanBuilder — so every change it makes is previewed, owned, journaled, and
 * reversible within its declared limits — and returns what the blueprint and
 * lock must record.
 */
import type { BlueprintApp, BlueprintCapability, BlueprintV2 } from "../contracts/blueprint.ts";
import type { RecipeDescriptor, SolverSelection } from "../contracts/capability.ts";
import type { Decision, EnvVarContract, VerificationContract } from "../contracts/common.ts";
import type { RecipeLock } from "../contracts/lock.ts";
import type { ProjectObservation, ProjectUnit } from "../contracts/project.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import type { CoreContext } from "../runtime.ts";

export type RecipeOptions = Readonly<Record<string, string | number | boolean>>;

export interface RecipeTarget {
  /** The blueprint app the capability is applied to. */
  readonly app: BlueprintApp;
  /** The observed unit at the same path (entry, deps, scripts), when discovery found it. */
  readonly unit: ProjectUnit | undefined;
}

export interface RecipePlanInput {
  readonly ctx: CoreContext;
  readonly root: string;
  readonly builder: PlanBuilder;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation;
  readonly target: RecipeTarget;
  readonly options: RecipeOptions;
  /** Selections planned earlier in the same operation (requirements first). */
  readonly earlier: readonly SolverSelection[];
  /**
   * Facts recipes hand to later recipes of the same plan, e.g. the data
   * recipe publishes where its database module lives so auth can import it.
   */
  readonly shared: Map<string, unknown>;
}

export interface RecipeContribution {
  readonly capability: BlueprintCapability;
  readonly env: readonly EnvVarContract[];
  readonly verification: readonly VerificationContract[];
  readonly lock: RecipeLock;
  readonly decisions: readonly Decision[];
}

export interface Recipe {
  readonly descriptor: RecipeDescriptor;
  /** Reasons the recipe cannot target this app; empty means compatible. */
  compatibility(target: RecipeTarget, observation: ProjectObservation): string[];
  /** Contribute actions (via input.builder) and return the blueprint/lock records. */
  plan(input: RecipePlanInput): Promise<RecipeContribution>;
}
