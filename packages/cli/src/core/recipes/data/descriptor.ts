/**
 * data.drizzle-sqlite — the data half of the recipe contract: what it
 * installs (exact versions), where it applies, what it refuses to layer over,
 * the environment it needs, how it is verified, and what rollback can undo.
 */
import type { RecipeDescriptor } from "../../contracts/capability.ts";
import { NEEDS_BUN, NEEDS_NOTHING } from "../contracts.ts";
import {
  CERTIFICATION,
  DATA_RECIPE_ID,
  DATA_RECIPE_VERSION,
  PINS,
  RECIPE_SUPPORT,
} from "../versions.ts";

const otherDataLayer = (name: string, what: string) => ({
  capability: null,
  recipe: null,
  dependency: name,
  reason: `${what} already manages this app's database — Groot won't layer a second data layer over it`,
});

export const DATA_DESCRIPTOR: RecipeDescriptor = {
  id: DATA_RECIPE_ID,
  version: DATA_RECIPE_VERSION,
  capability: "data",
  title: "Drizzle ORM on bun:sqlite",
  summary:
    "Typed SQLite persistence for a Bun + Hono API: a Drizzle client over bun:sqlite, a starter schema, versioned migrations (drizzle-kit generate + the bun-sqlite migrator), and DATABASE_URL wiring.",
  support: RECIPE_SUPPORT,
  provides: ["data"],
  requires: [],
  conflicts: [
    otherDataLayer("drizzle-orm", "An existing Drizzle setup"),
    otherDataLayer("prisma", "Prisma"),
    otherDataLayer("@prisma/client", "Prisma"),
    otherDataLayer("kysely", "Kysely"),
    otherDataLayer("typeorm", "TypeORM"),
    otherDataLayer("mongoose", "Mongoose"),
  ],
  targets: {
    kinds: ["api"],
    frameworks: ["hono"],
    runtimes: ["bun"],
    topologies: ["single", "monorepo"],
  },
  dependencies: { "drizzle-orm": PINS.drizzleOrm },
  devDependencies: { "drizzle-kit": PINS.drizzleKit },
  env: [
    {
      name: "DATABASE_URL",
      scope: "server",
      sensitivity: "config",
      required: true,
      description:
        "SQLite database for bun:sqlite — file:<path>, a bare path, or :memory:; relative paths resolve against the app directory",
      example: "./data/app.db",
      generate: "none",
      declaredBy: DATA_RECIPE_ID,
    },
  ],
  verification: [
    {
      id: "data.structural",
      profile: "structural",
      description:
        "data.drizzle-sqlite wiring is intact: owned files, pinned dependencies, and a consistent migration journal",
      checker: "structural.recipe",
      capability: "data",
      needs: NEEDS_NOTHING,
    },
    {
      id: "data.build",
      profile: "build",
      description: "the server entry bundles with the database modules (bun build --target bun)",
      checker: "build.bundle",
      capability: "data",
      needs: NEEDS_BUN,
    },
    {
      id: "data.runtime",
      profile: "runtime",
      description:
        "migrations apply to a fresh temporary database and the server answers HTTP on an ephemeral port",
      checker: "runtime.http",
      capability: "data",
      needs: NEEDS_BUN,
    },
  ],
  external: [],
  recovery: {
    mode: "full",
    summary:
      "Rollback deletes the files data.drizzle-sqlite created and restores package.json, .gitignore, .env.example, and .env.local from journaled backups when they are unchanged since apply; bun install then re-syncs node_modules.",
    irreversible: [],
    limits: [
      "A local database created later by db:migrate (<app>/data/) is not deleted by rollback.",
      "Files edited by hand after apply are reported as rollback conflicts, never overwritten.",
    ],
  },
  certification: CERTIFICATION,
};
