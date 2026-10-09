/**
 * One-time registration of the built-in recipes and verification checkers.
 * Idempotent; every surface (CLI commands, the MCP API) calls it before use.
 */
import { registerBuiltInRecipes, registerRecipeCheckers } from "./recipes/index.ts";
import { registerBuiltInCheckers } from "./verify/checkers.ts";

let registered = false;

export function bootstrapCore(): void {
  if (registered) return;
  registered = true;
  registerBuiltInCheckers();
  registerBuiltInRecipes();
  registerRecipeCheckers();
}
