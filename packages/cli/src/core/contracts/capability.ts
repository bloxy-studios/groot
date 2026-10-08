/**
 * Capability contract — a product or operational result (authentication,
 * persistence, a web surface, agent context) and the recipes that can supply
 * it. Recipes are the certified unit: requirements, conflicts, exact
 * versions, transforms, environment contracts, verification, external setup,
 * and recovery limits travel together (core/capabilities/).
 *
 * Distinctions kept explicit: application frameworks (Next.js, Hono) are
 * `surface` capabilities supplied by scaffold adapters; provider services
 * (a database server, an identity provider) appear as external effects; and
 * agents used by developers (runners) are never modeled as capabilities of
 * the product — an AI feature inside the product would be its own capability.
 */
import { z } from "zod";
import { EnvVarContract, Topology, UnitKind, VerificationContract } from "./common.ts";

export const SupportLevel = z.enum(["certified", "experimental", "planned"]);
export type SupportLevel = z.infer<typeof SupportLevel>;

export const CapabilityKind = z.enum(["product", "operational", "surface"]);

export const CapabilityDescriptor = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string(),
    kind: CapabilityKind,
    description: z.string(),
    /** Capabilities that must be present first (auth → data). */
    requires: z.array(z.string()),
    recipes: z.array(z.string()),
  })
  .strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

export const ExternalEffect = z
  .object({
    provider: z.string(),
    effect: z.string(),
    cost: z.enum(["free", "paid", "unknown"]),
    reversible: z.boolean(),
    requiresCredentials: z.array(z.string()),
    compensation: z.string().nullable(),
  })
  .strict();
export type ExternalEffect = z.infer<typeof ExternalEffect>;

export const RecoveryInfo = z
  .object({
    mode: z.enum(["full", "partial", "none"]),
    summary: z.string(),
    irreversible: z.array(z.string()),
    limits: z.array(z.string()),
  })
  .strict();
export type RecoveryInfo = z.infer<typeof RecoveryInfo>;

export const RecipeConflict = z
  .object({
    capability: z.string().nullable(),
    recipe: z.string().nullable(),
    /** A dependency whose presence makes the recipe unsafe (e.g. another auth library). */
    dependency: z.string().nullable(),
    reason: z.string(),
  })
  .strict();

/** The data half of a recipe (its executable half lives in core/recipes/). */
export const RecipeDescriptor = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/),
    version: z.string(),
    capability: z.string(),
    title: z.string(),
    summary: z.string(),
    support: SupportLevel,
    provides: z.array(z.string()),
    requires: z.array(
      z
        .object({
          capability: z.string(),
          /** Recipes that satisfy the requirement compatibly (empty = any). */
          recipes: z.array(z.string()),
        })
        .strict(),
    ),
    conflicts: z.array(RecipeConflict),
    targets: z
      .object({
        kinds: z.array(UnitKind),
        frameworks: z.array(z.string()),
        runtimes: z.array(z.enum(["bun", "node"])),
        topologies: z.array(Topology),
      })
      .strict(),
    /** Exact versions the recipe installs (package → version). */
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
    env: z.array(EnvVarContract.omit({ consumer: true, storage: true })),
    verification: z.array(VerificationContract.omit({ unit: true })),
    external: z.array(ExternalEffect),
    recovery: RecoveryInfo,
    /** What certification was performed, when, and against which versions. */
    certification: z
      .object({
        evidence: z.string(),
        checkedAt: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RecipeDescriptor = z.infer<typeof RecipeDescriptor>;

export const SolverSelection = z
  .object({
    capability: z.string(),
    recipe: z.string(),
    recipeVersion: z.string(),
    target: z.string(),
    reason: z.enum(["requested", "dependency"]),
    alreadySatisfied: z.boolean(),
  })
  .strict();
export type SolverSelection = z.infer<typeof SolverSelection>;

export const SolverRefusal = z
  .object({
    code: z.enum([
      "unknown-capability",
      "unknown-recipe",
      "no-compatible-target",
      "recipe-conflict",
      "dependency-conflict",
      "missing-requirement",
      "unsupported-topology",
      "not-certified",
      "ambiguous-choice",
    ]),
    message: z.string(),
    alternatives: z.array(z.string()),
  })
  .strict();
export type SolverRefusal = z.infer<typeof SolverRefusal>;

export const SolverResult = z
  .object({
    ok: z.boolean(),
    /** In application order (dependencies first). */
    selections: z.array(SolverSelection),
    refusals: z.array(SolverRefusal),
  })
  .strict();
export type SolverResult = z.infer<typeof SolverResult>;
