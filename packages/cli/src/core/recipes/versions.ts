/**
 * Exact versions the built-in recipes install, and their certification
 * record.
 *
 * Pins come from the 2026-10-07 prototype (Bun + Hono + Drizzle on bun:sqlite
 * + Better Auth) and were re-checked against the npm registry on 2026-10-08:
 * each is the current `latest`, none is deprecated, none has required peers.
 * Bumping a pin means regenerating the static migrations (data/migration.ts)
 * and the Better Auth schema with the new tools, then re-running the
 * certification suite (recipes.e2e.test.ts with GROOT_RECIPE_E2E=1).
 */
import type { RecipeDescriptor, SupportLevel } from "../contracts/capability.ts";

export const PINS = {
  drizzleOrm: "0.45.3",
  drizzleKit: "0.31.11",
  betterAuth: "1.7.7",
  /** The Better Auth CLI (`auth` package) behind `auth:generate` — run with bunx, never installed. */
  authCli: "1.7.7",
} as const;

export const DATA_RECIPE_ID = "data.drizzle-sqlite";
export const AUTH_RECIPE_ID = "auth.better-auth";
export const DATA_RECIPE_VERSION = "1.0.0";
export const AUTH_RECIPE_VERSION = "1.0.0";

/**
 * "certified" only once the GROOT_RECIPE_E2E suite has passed every profile
 * (structural, build, runtime, product-flow) on a fresh single-app project, a
 * Bun monorepo, and an adopted custom layout.
 */
export const RECIPE_SUPPORT: SupportLevel = "experimental";

/** What certification was performed (null until the suite has passed). */
export const CERTIFICATION: RecipeDescriptor["certification"] = null;
