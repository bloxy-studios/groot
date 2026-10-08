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
 * "certified" only while the GROOT_RECIPE_E2E suite passes every profile
 * (structural, build, runtime, product-flow) on a fresh single-app project, a
 * Bun monorepo, and an adopted custom layout — re-run it after any pin,
 * template, or migration change, and drop back to "experimental" if it fails.
 */
export const RECIPE_SUPPORT: SupportLevel = "certified";

/** What certification was performed, against which versions and platform. */
export const CERTIFICATION: RecipeDescriptor["certification"] = {
  evidence:
    "GROOT_RECIPE_E2E=1 bun test src/core/recipes/recipes.e2e.test.ts: (a) fresh single app from create-hono 0.19.5, (b) Bun workspace with apps/api from create-hono 0.19.5, (c) adopted custom layout (server/main.ts, port 4310, custom scripts, dirty tree) — planned with the PlanBuilder, materialized, bun install, then structural, build, runtime, and product-flow (24-step auth flow) all pass; drizzle-kit reports no schema drift afterwards. macOS x64, Bun 1.4.0; Linux and Windows not yet certified.",
  checkedAt: "2026-10-08",
};
