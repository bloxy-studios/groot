/**
 * data.drizzle-sqlite — the executable half. Planned actions, in order:
 *
 * 1. recipe-owned modules next to the server entry (<src>/db/sqlite.ts,
 *    client.ts, migrate.ts) and <app>/drizzle.config.ts;
 * 2. the starter schema <src>/db/schema.ts (human-owned from then on);
 * 3. the static migration 0000_data_init + its snapshot, and drizzle-kit's
 *    journal holding exactly that entry;
 * 4. package.json: db:generate/db:migrate scripts, then one deps.add with
 *    exact versions;
 * 5. .gitignore lines for .env.local and the SQLite directory (only when git
 *    doesn't already ignore them), DATABASE_URL in .env.example (placeholder)
 *    and in .env.local (local default, computed at apply time).
 *
 * The data layout is published in `shared` so auth, planned next in the same
 * operation, mounts against the same database module.
 */
import type { BlueprintCapability } from "../../contracts/blueprint.ts";
import type { OwnedArtifact, RecipeLock } from "../../contracts/lock.ts";
import { joinRel } from "../../fs/paths.ts";
import type { PlanBuilder } from "../../planner/builder.ts";
import { envFor, verificationFor } from "../contracts.ts";
import { inSrc, layoutCompatibility, type RecipeLayout, requireLayout } from "../layout.ts";
import {
  DATA_MIGRATION,
  journalFile,
  snapshotFile,
  snapshotFileName,
  sqlFileName,
} from "../migrations.ts";
import {
  addDependencies,
  ensureScripts,
  recipeDecision,
  writeOwned,
  writeStarter,
} from "../plan-helpers.ts";
import {
  addEnvExample,
  addEnvLocal,
  assertUntracked,
  dataDirTarget,
  ensureIgnored,
  envLocalTarget,
} from "../project-files.ts";
import type { Recipe, RecipeContribution, RecipePlanInput } from "../types.ts";
import { DATA_RECIPE_ID, DATA_RECIPE_VERSION, PINS } from "../versions.ts";
import { DATA_DESCRIPTOR } from "./descriptor.ts";
import { CLIENT_TS, drizzleConfigTs, migrateTs, SCHEMA_TS, SQLITE_TS } from "./templates.ts";

/** `shared` key under which data publishes its layout for later recipes of the same plan. */
export function dataLayoutKey(appId: string): string {
  return `${DATA_RECIPE_ID}:${appId}:layout`;
}

export const DEFAULT_DATABASE_URL = "./data/app.db";

export function dataScripts(layout: RecipeLayout): Record<string, string> {
  return {
    "db:generate": "drizzle-kit generate",
    "db:migrate": `bun run ${inSrc(layout, "db", "migrate.ts")}`,
  };
}

async function planModules(builder: PlanBuilder, layout: RecipeLayout): Promise<OwnedArtifact[]> {
  const sqlite = await writeOwned(builder, {
    path: `${layout.db}/sqlite.ts`,
    content: SQLITE_TS,
    description: `create ${layout.db}/sqlite.ts (opens DATABASE_URL with bun:sqlite)`,
  });
  const client = await writeOwned(builder, {
    path: `${layout.db}/client.ts`,
    content: CLIENT_TS,
    description: `create ${layout.db}/client.ts (the Drizzle client \`db\`)`,
  });
  await writeStarter(
    builder,
    {
      path: `${layout.db}/schema.ts`,
      content: SCHEMA_TS,
      description: `create the starter schema ${layout.db}/schema.ts (yours to edit)`,
    },
    {
      owner: "human",
      parts: [],
      note: "starter schema from data.drizzle-sqlite — yours to edit; recipes only add managed regions",
    },
  );
  const migrate = await writeOwned(builder, {
    path: `${layout.db}/migrate.ts`,
    content: migrateTs(layout),
    description: `create ${layout.db}/migrate.ts (applies drizzle/ migrations: bun run db:migrate)`,
  });
  const config = await writeOwned(builder, {
    path: joinRel(layout.appDir, "drizzle.config.ts"),
    content: drizzleConfigTs(layout),
    description: `create ${joinRel(layout.appDir, "drizzle.config.ts")} (drizzle-kit, offline generate)`,
  });
  return [sqlite, client, migrate, config];
}

async function planMigration(builder: PlanBuilder, layout: RecipeLayout): Promise<OwnedArtifact[]> {
  const sql = await writeOwned(builder, {
    path: `${layout.drizzle}/${sqlFileName(DATA_MIGRATION.entry)}`,
    content: DATA_MIGRATION.sql,
    description: `add migration ${DATA_MIGRATION.entry.tag} (creates the starter todos table)`,
  });
  const snapshot = await writeOwned(builder, {
    path: `${layout.drizzle}/${snapshotFileName(DATA_MIGRATION.entry)}`,
    content: snapshotFile(DATA_MIGRATION),
    description: `add drizzle-kit's schema snapshot for ${DATA_MIGRATION.entry.tag}`,
  });
  await writeStarter(
    builder,
    {
      path: layout.journal,
      content: journalFile([DATA_MIGRATION.entry]),
      description: `create drizzle-kit's migration journal with entry ${DATA_MIGRATION.entry.tag}`,
    },
    {
      owner: "shared",
      parts: ["/entries/0"],
      note: "drizzle-kit appends entries on db:generate; data.drizzle-sqlite wrote entry 0000",
    },
  );
  return [sql, snapshot];
}

async function planProjectFiles(input: RecipePlanInput, layout: RecipeLayout): Promise<void> {
  const { builder, root } = input;
  const scriptKeys = await ensureScripts(builder, layout, dataScripts(layout), DATA_RECIPE_ID);
  const depKeys = await addDependencies(builder, layout, [
    { name: "drizzle-orm", version: PINS.drizzleOrm, dev: false },
    { name: "drizzle-kit", version: PINS.drizzleKit, dev: true },
  ]);
  builder.own({
    path: layout.packageJson,
    owner: "shared",
    parts: [...scriptKeys, ...depKeys],
    note: "data.drizzle-sqlite adds these keys; the rest of package.json is yours",
  });
  // Ignore lines are planned before any env write so nothing local is ever committable.
  await ensureIgnored(
    builder,
    root,
    layout.appDir,
    [envLocalTarget(layout), dataDirTarget(layout)],
    DATA_RECIPE_ID,
  );
  await addEnvExample(
    builder,
    layout,
    [
      {
        name: "DATABASE_URL",
        value: DEFAULT_DATABASE_URL,
        comment:
          "SQLite database (bun:sqlite): file:<path>, a bare path, or :memory: — relative to this app's directory",
      },
    ],
    DATA_RECIPE_ID,
  );
  await addEnvLocal(
    builder,
    layout,
    [{ name: "DATABASE_URL", value: DEFAULT_DATABASE_URL, comment: "local SQLite database" }],
    DATA_RECIPE_ID,
  );
}

function contribution(
  input: RecipePlanInput,
  layout: RecipeLayout,
  artifacts: OwnedArtifact[],
): RecipeContribution {
  const { builder } = input;
  const app = input.target.app;
  const capability: BlueprintCapability = {
    id: "data",
    recipe: DATA_RECIPE_ID,
    recipeVersion: DATA_RECIPE_VERSION,
    target: app.id,
    options: {},
    addedBy: builder.planId,
    addedAt: builder.createdAt,
  };
  const lock: RecipeLock = {
    capability: "data",
    recipe: DATA_RECIPE_ID,
    recipeVersion: DATA_RECIPE_VERSION,
    target: app.id,
    appliedBy: builder.planId,
    plannedAt: builder.createdAt,
    dependencies: { "drizzle-orm": PINS.drizzleOrm, "drizzle-kit": PINS.drizzleKit },
    artifacts,
  };
  const decision = (topic: string, value: string, rationale: string) =>
    recipeDecision({
      recipe: DATA_RECIPE_ID,
      version: DATA_RECIPE_VERSION,
      app: app.id,
      topic,
      value,
      rationale,
      at: builder.createdAt,
    });
  return {
    capability,
    env: envFor(DATA_DESCRIPTOR.env, layout),
    verification: verificationFor(DATA_DESCRIPTOR.verification, app),
    lock,
    decisions: [
      decision(
        "data.store",
        `SQLite through bun:sqlite and Drizzle ORM ${PINS.drizzleOrm}; DATABASE_URL defaults to ${DEFAULT_DATABASE_URL} in ${app.path}`,
        "Zero infrastructure, Bun-native, and fully verifiable locally against temporary databases.",
      ),
      decision(
        "data.migrations",
        `versioned SQL in ${layout.drizzle}: bun run db:generate (drizzle-kit ${PINS.drizzleKit}) writes migrations, bun run db:migrate applies them`,
        "Migrations are reviewable files; the recipe's own migration ships pre-generated so the plan previews its exact SQL.",
      ),
    ],
  };
}

async function planData(input: RecipePlanInput): Promise<RecipeContribution> {
  const layout = requireLayout(input.target, DATA_RECIPE_ID);
  await assertUntracked(input.root, layout.envLocal, DATA_RECIPE_ID);
  const artifacts = [
    ...(await planModules(input.builder, layout)),
    ...(await planMigration(input.builder, layout)),
  ];
  await planProjectFiles(input, layout);
  input.shared.set(dataLayoutKey(input.target.app.id), layout);
  return contribution(input, layout, artifacts);
}

export const dataDrizzleSqlite: Recipe = {
  descriptor: DATA_DESCRIPTOR,
  compatibility: (target) => layoutCompatibility(target, DATA_RECIPE_ID),
  plan: planData,
};
