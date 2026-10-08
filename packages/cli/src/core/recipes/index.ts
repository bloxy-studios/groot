/**
 * Built-in recipes and the checkers that verify them.
 *
 * - data.drizzle-sqlite (capability "data"): Drizzle ORM on bun:sqlite with
 *   static, previewable migrations.
 * - auth.better-auth (capability "auth", requires data via
 *   data.drizzle-sqlite): Better Auth email/password, mounted into the Hono
 *   entry, with per-user notes as the protected example.
 *
 * Checkers registered by registerRecipeCheckers():
 * - structural.recipe — owned files/regions, pins, migration journal (offline);
 * - build.bundle      — `bun build` of the entry (every import resolves);
 * - runtime.http      — migrate a temporary database, start the app, probe it;
 * - auth.flow         — the 24-step product flow over HTTP against the app.
 *
 * Both functions are idempotent (registries are keyed by id); every surface
 * calls them once at startup (core/bootstrap.ts).
 */
import { registerRecipe } from "../capabilities/registry.ts";
import { type Checker, registerChecker } from "../verify/engine.ts";
import { authBetterAuth } from "./auth/recipe.ts";
import { authFlowCheck } from "./checkers/auth-flow.ts";
import { bundleCheck } from "./checkers/build-bundle.ts";
import { runtimeHttpCheck } from "./checkers/runtime-http.ts";
import { structuralRecipeCheck } from "./checkers/structural.ts";
import { dataDrizzleSqlite } from "./data/recipe.ts";
import type { Recipe } from "./types.ts";

/** In application order: data before auth (auth requires data). */
export const BUILT_IN_RECIPES: readonly Recipe[] = [dataDrizzleSqlite, authBetterAuth];

export const RECIPE_CHECKERS: Readonly<Record<string, Checker>> = {
  "structural.recipe": structuralRecipeCheck,
  "build.bundle": bundleCheck,
  "runtime.http": runtimeHttpCheck,
  "auth.flow": authFlowCheck,
};

export function registerBuiltInRecipes(): void {
  for (const recipe of BUILT_IN_RECIPES) registerRecipe(recipe);
}

export function registerRecipeCheckers(): void {
  for (const [id, checker] of Object.entries(RECIPE_CHECKERS)) registerChecker(id, checker);
}

export { authBetterAuth } from "./auth/recipe.ts";
export { dataDrizzleSqlite } from "./data/recipe.ts";
