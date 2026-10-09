/**
 * auth.better-auth — the data half of the recipe contract. Auth requires the
 * data capability through data.drizzle-sqlite specifically: its tables,
 * migration 0001, and adapter wiring are built on that recipe's client,
 * schema barrel, and migration journal.
 */
import type { RecipeDescriptor } from "../../contracts/capability.ts";
import { NEEDS_BUN, NEEDS_NOTHING } from "../contracts.ts";
import {
  AUTH_RECIPE_ID,
  AUTH_RECIPE_VERSION,
  CERTIFICATION,
  DATA_RECIPE_ID,
  PINS,
  RECIPE_SUPPORT,
} from "../versions.ts";

const otherAuth = (name: string, what: string) => ({
  capability: null,
  recipe: null,
  dependency: name,
  reason: `${what} already handles authentication here — Groot won't add a second auth system`,
});

export const AUTH_DESCRIPTOR: RecipeDescriptor = {
  id: AUTH_RECIPE_ID,
  version: AUTH_RECIPE_VERSION,
  capability: "auth",
  title: "Better Auth (email + password) on Drizzle",
  summary:
    "Accounts, cookie sessions, and a server-enforced protected route for a Bun + Hono API: Better Auth with email/password on the Drizzle adapter, routes at /api/auth, and per-user notes at /api/notes as the protected example.",
  support: RECIPE_SUPPORT,
  provides: ["auth"],
  requires: [{ capability: "data", recipes: [DATA_RECIPE_ID] }],
  conflicts: [
    otherAuth("better-auth", "An existing Better Auth setup"),
    otherAuth("next-auth", "Auth.js (next-auth)"),
    otherAuth("@auth/core", "Auth.js (@auth/core)"),
    otherAuth("lucia", "Lucia"),
    otherAuth("@clerk/backend", "Clerk"),
    otherAuth("@clerk/clerk-sdk-node", "Clerk"),
  ],
  targets: {
    kinds: ["api"],
    frameworks: ["hono"],
    runtimes: ["bun"],
    topologies: ["single", "monorepo"],
  },
  dependencies: { "better-auth": PINS.betterAuth },
  devDependencies: {},
  env: [
    {
      name: "BETTER_AUTH_SECRET",
      scope: "server",
      sensitivity: "secret",
      required: true,
      description:
        "Signs session cookies and tokens. Groot generates a local value into the gitignored env file; production needs its own random value of at least 32 characters.",
      example: "",
      generate: "random-secret",
      declaredBy: AUTH_RECIPE_ID,
    },
    {
      name: "BETTER_AUTH_URL",
      scope: "server",
      sensitivity: "config",
      required: true,
      description:
        "This API's public origin (scheme, host, port); Better Auth trusts it for Origin checks and builds its URLs from it.",
      example: "http://localhost:3000",
      generate: "local-url",
      declaredBy: AUTH_RECIPE_ID,
    },
    {
      name: "BETTER_AUTH_TRUSTED_ORIGINS",
      scope: "server",
      sensitivity: "config",
      required: false,
      description:
        "Optional comma-separated browser origins (e.g. the web app) allowed to call this API with cookies.",
      example: "",
      generate: "none",
      declaredBy: AUTH_RECIPE_ID,
    },
  ],
  verification: [
    {
      id: "auth.structural",
      profile: "structural",
      description:
        "auth.better-auth wiring is intact: owned files, the mounted route and schema regions, and the pinned dependency",
      checker: "structural.recipe",
      capability: "auth",
      needs: NEEDS_NOTHING,
    },
    {
      id: "auth.build",
      profile: "build",
      description: "the server entry bundles with the auth routes (bun build --target bun)",
      checker: "build.bundle",
      capability: "auth",
      needs: NEEDS_BUN,
    },
    {
      id: "auth.runtime",
      profile: "runtime",
      description:
        "the server starts with auth configured on a fresh temporary database and GET /api/auth/ok answers 200",
      checker: "runtime.http",
      capability: "auth",
      needs: NEEDS_BUN,
    },
    {
      id: "auth.flow",
      profile: "product-flow",
      description:
        "sign-up, sessions, and per-user notes against the running app; unauthenticated, tampered-cookie, cross-user, cross-origin, Origin-less (CSRF), and signed-out requests are rejected",
      checker: "auth.flow",
      capability: "auth",
      needs: NEEDS_BUN,
    },
  ],
  external: [],
  recovery: {
    mode: "full",
    summary:
      "Rollback deletes the auth modules and migration 0001, removes the auth regions from the server entry and the schema barrel, and restores package.json, the migration journal, .gitignore, .env.example, and .env.local from journaled backups when they are unchanged since apply.",
    irreversible: [],
    limits: [
      "Users and sessions already stored in a local database stay there — rollback never touches databases.",
      "Changing BETTER_AUTH_SECRET invalidates every session issued with the previous value.",
      "Files edited by hand after apply are reported as rollback conflicts, never overwritten.",
    ],
  },
  certification: CERTIFICATION,
};
