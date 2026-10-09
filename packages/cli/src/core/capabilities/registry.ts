/**
 * Capability and recipe registry — what Groot can add to a project and which
 * certified recipes supply it. Capabilities are product/operational results;
 * recipes are the certified, versioned implementations (core/recipes/).
 */
import type { CapabilityDescriptor, RecipeDescriptor } from "../contracts/capability.ts";
import type { Recipe } from "../recipes/types.ts";

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: "data",
    title: "Typed persistence",
    kind: "product",
    description:
      "A typed database layer with versioned migrations that the app's server code owns and queries.",
    requires: [],
    recipes: [],
  },
  {
    id: "auth",
    title: "Authentication",
    kind: "product",
    description:
      "User accounts, sessions, and a protected-route boundary enforced by the server, with sign-up, sign-in, and sign-out.",
    requires: ["data"],
    recipes: [],
  },
];

const recipes = new Map<string, Recipe>();

/** Register a recipe (core/recipes/index.ts registers the built-in ones). */
export function registerRecipe(recipe: Recipe): void {
  recipes.set(recipe.descriptor.id, recipe);
}

export function getRecipe(id: string): Recipe | undefined {
  return recipes.get(id);
}

export function listRecipes(): Recipe[] {
  return [...recipes.values()];
}

export function getCapability(id: string): CapabilityDescriptor | undefined {
  const capability = CAPABILITIES.find((entry) => entry.id === id);
  if (capability === undefined) return undefined;
  return {
    ...capability,
    recipes: listRecipes()
      .filter((recipe) => recipe.descriptor.capability === id)
      .map((recipe) => recipe.descriptor.id),
  };
}

export function listCapabilities(): CapabilityDescriptor[] {
  return CAPABILITIES.map((capability) => getCapability(capability.id) as CapabilityDescriptor);
}

/** Descriptors only (for `groot schema`/MCP discovery). */
export function recipeDescriptors(): RecipeDescriptor[] {
  return listRecipes().map((recipe) => recipe.descriptor);
}
