/**
 * auth.better-auth — the executable half. It builds on data.drizzle-sqlite's
 * layout (planned earlier in the same operation, or applied before):
 *
 * 1. recipe-owned modules next to the server entry: auth.ts (Better Auth),
 *    db/auth-schema.ts + db/notes-schema.ts, http/{cors,session,auth-routes,
 *    notes-routes}.ts;
 * 2. the static migration 0001_auth_init + snapshot, appended to the journal —
 *    only when the journal holds exactly data's 0000 (anything else means the
 *    schema moved on and a pre-generated 0001 would be wrong → conflict);
 * 3. managed regions: `auth.schema` in the schema barrel, `auth.imports` +
 *    `auth.routes` in the server entry (anchored on the unique Hono import and
 *    `new Hono(` declaration — missing or ambiguous anchors are conflicts);
 * 4. package.json: the auth:generate script, then better-auth at its exact pin;
 * 5. .env.local ignored, placeholders in .env.example, BETTER_AUTH_URL for the
 *    app's port, and a generated BETTER_AUTH_SECRET (an env.secret step — the
 *    value never enters the plan) unless the developer already set one.
 */
import type { BlueprintCapability } from "../../contracts/blueprint.ts";
import type { Decision } from "../../contracts/common.ts";
import type { OwnedArtifact, RecipeLock } from "../../contracts/lock.ts";
import { GrootV2Error } from "../../errors.ts";
import { sha256Of } from "../../fs/hash.ts";
import { joinRel } from "../../fs/paths.ts";
import type { PlanBuilder } from "../../planner/builder.ts";
import { envFor, verificationFor } from "../contracts.ts";
import { dataLayoutKey } from "../data/recipe.ts";
import {
  appPort,
  inSrc,
  layoutCompatibility,
  type RecipeLayout,
  requireLayout,
} from "../layout.ts";
import {
  AUTH_MIGRATION,
  DATA_MIGRATION,
  snapshotFile,
  snapshotFileName,
  sqlFileName,
} from "../migrations.ts";
import {
  addDependencies,
  ensureScripts,
  type PlannedFile,
  recipeDecision,
  writeOwned,
} from "../plan-helpers.ts";
import {
  addEnvExample,
  addEnvLocal,
  addSecret,
  assertUntracked,
  ensureIgnored,
  envLocalTarget,
} from "../project-files.ts";
import type { Recipe, RecipeContribution, RecipePlanInput } from "../types.ts";
import { AUTH_RECIPE_ID, AUTH_RECIPE_VERSION, DATA_RECIPE_ID, PINS } from "../versions.ts";
import { AUTH_DESCRIPTOR } from "./descriptor.ts";
import {
  analyzeEntry,
  type EntryAnalysis,
  IMPORTS_REGION,
  importsEdit,
  ROUTES_REGION,
  routesEdit,
} from "./entry.ts";
import {
  AUTH_ROUTES_TS,
  AUTH_SCHEMA_TS,
  AUTH_TS,
  CORS_TS,
  NOTES_ROUTES_TS,
  NOTES_SCHEMA_TS,
  SCHEMA_REGION,
  SESSION_TS,
} from "./templates.ts";

export const SCHEMA_REGION_ID = "auth.schema";
export const SECRET_NAME = "BETTER_AUTH_SECRET";

export function authScripts(layout: RecipeLayout): Record<string, string> {
  // :memory: keeps the CLI from creating a database file when it loads auth.ts.
  return {
    "auth:generate": `DATABASE_URL=:memory: bunx --bun auth@${PINS.authCli} generate --yes --config ${inSrc(layout, "auth.ts")} --output ${inSrc(layout, "db", "auth-schema.ts")}`,
  };
}

export function localAuthUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** The data layer auth builds on must exist — pending in this plan or on disk. */
async function requireDataLayer(builder: PlanBuilder, layout: RecipeLayout): Promise<string> {
  const required = [joinRel(layout.db, "client.ts"), joinRel(layout.db, "schema.ts")];
  for (const path of required) {
    if ((await builder.currentContent(path)) === null) {
      throw new GrootV2Error(
        "GROOT_E_INCOMPATIBLE",
        `${AUTH_RECIPE_ID} builds on ${DATA_RECIPE_ID}, but ${path} is missing.`,
        {
          hint: "Plan auth together with data (auth requires data), or restore the data layer first.",
          details: { path, requires: DATA_RECIPE_ID },
        },
      );
    }
  }
  const journal = await builder.currentContent(layout.journal);
  if (journal === null) {
    throw new GrootV2Error(
      "GROOT_E_INCOMPATIBLE",
      `${AUTH_RECIPE_ID} builds on ${DATA_RECIPE_ID}, but the migration journal ${layout.journal} is missing.`,
      { details: { path: layout.journal, requires: DATA_RECIPE_ID } },
    );
  }
  return journal;
}

/** "ready" = only data's 0000; "applied" = 0000 + auth's 0001 already; anything else conflicts. */
export function journalState(text: string, path: string): "ready" | "applied" {
  let tags: unknown[] = [];
  try {
    const entries = (JSON.parse(text) as { entries?: unknown }).entries;
    tags = Array.isArray(entries) ? entries.map((entry) => (entry as { tag?: unknown })?.tag) : [];
  } catch {
    tags = [];
  }
  const data = DATA_MIGRATION.entry.tag;
  const auth = AUTH_MIGRATION.entry.tag;
  if (tags.length === 1 && tags[0] === data) return "ready";
  if (tags.length === 2 && tags[0] === data && tags[1] === auth) return "applied";
  throw new GrootV2Error(
    "GROOT_E_CONFLICT",
    `${path} lists ${tags.length === 0 ? "no readable migrations" : `migrations ${tags.join(", ")}`}; ${AUTH_RECIPE_ID} ships ${auth} pre-generated to follow ${data} directly.`,
    {
      hint: "The schema has moved on since data was added, so a pre-generated 0001 would be wrong and Groot won't guess. Set up Better Auth by hand (its CLI generates tables for your current schema; then bun run db:generate), or plan auth on an app whose journal holds only 0000_data_init.",
      details: { path, conflict: "migration-journal", entries: tags },
    },
  );
}

function moduleFiles(layout: RecipeLayout): PlannedFile[] {
  const http = (name: string, content: string, what: string): PlannedFile => ({
    path: joinRel(layout.http, name),
    content,
    description: `create ${joinRel(layout.http, name)} (${what})`,
  });
  return [
    {
      path: joinRel(layout.src, "auth.ts"),
      content: AUTH_TS,
      description: `create ${joinRel(layout.src, "auth.ts")} (Better Auth: email + password on the Drizzle adapter)`,
    },
    {
      path: joinRel(layout.db, "auth-schema.ts"),
      content: AUTH_SCHEMA_TS,
      description: `create ${joinRel(layout.db, "auth-schema.ts")} (Better Auth tables; bun run auth:generate rewrites it)`,
    },
    {
      path: joinRel(layout.db, "notes-schema.ts"),
      content: NOTES_SCHEMA_TS,
      description: `create ${joinRel(layout.db, "notes-schema.ts")} (per-user notes, the protected example)`,
    },
    http("cors.ts", CORS_TS, "credentialed CORS for trusted origins"),
    http("session.ts", SESSION_TS, "requireSession middleware → 401 without a live session"),
    http("auth-routes.ts", AUTH_ROUTES_TS, "Better Auth's HTTP surface at /api/auth"),
    http("notes-routes.ts", NOTES_ROUTES_TS, "per-user notes at /api/notes"),
    {
      path: joinRel(layout.drizzle, sqlFileName(AUTH_MIGRATION.entry)),
      content: AUTH_MIGRATION.sql,
      description: `add migration ${AUTH_MIGRATION.entry.tag} (user, session, account, verification, notes)`,
    },
    {
      path: joinRel(layout.drizzle, snapshotFileName(AUTH_MIGRATION.entry)),
      content: snapshotFile(AUTH_MIGRATION),
      description: `add drizzle-kit's schema snapshot for ${AUTH_MIGRATION.entry.tag}`,
    },
  ];
}

async function planModules(builder: PlanBuilder, layout: RecipeLayout): Promise<OwnedArtifact[]> {
  const artifacts: OwnedArtifact[] = [];
  for (const file of moduleFiles(layout)) artifacts.push(await writeOwned(builder, file));
  return artifacts;
}

async function planJournal(
  builder: PlanBuilder,
  layout: RecipeLayout,
  text: string,
): Promise<void> {
  if (journalState(text, layout.journal) === "applied") return;
  await builder.editFile({
    path: layout.journal,
    edit: {
      kind: "json",
      ops: [{ op: "append-unique", pointer: "/entries", value: AUTH_MIGRATION.entry }],
    },
    description: `append ${AUTH_MIGRATION.entry.tag} to ${layout.journal}`,
    owns: ["/entries/1"],
    createIfMissing: false,
  });
  builder.own({
    path: layout.journal,
    owner: "shared",
    parts: ["/entries/1"],
    note: "drizzle-kit appends entries on db:generate; auth.better-auth wrote entry 0001",
  });
}

/** Region artifact recorded with the hash of the whole file right after Groot's edits. */
async function regionArtifact(
  builder: PlanBuilder,
  path: string,
  parts: string[],
): Promise<OwnedArtifact> {
  return {
    path,
    ownership: "region",
    parts,
    sha256: sha256Of((await builder.currentContent(path)) ?? ""),
  };
}

async function planRegions(
  builder: PlanBuilder,
  layout: RecipeLayout,
): Promise<{ artifacts: OwnedArtifact[]; analysis: EntryAnalysis }> {
  const schemaPath = joinRel(layout.db, "schema.ts");
  await builder.editFile({
    path: schemaPath,
    edit: {
      kind: "managed-region",
      regionId: SCHEMA_REGION_ID,
      content: SCHEMA_REGION,
      commentStyle: "slash",
      placement: "end",
    },
    description: `export the auth tables and notes from ${schemaPath} (managed region ${SCHEMA_REGION_ID})`,
    owns: [SCHEMA_REGION_ID],
    createIfMissing: false,
  });
  const entryText = await builder.currentContent(layout.entry);
  if (entryText === null) {
    throw new GrootV2Error("GROOT_E_CONFLICT", `The server entry ${layout.entry} does not exist.`, {
      hint: "Record the app's real entry in groot.json (apps[].entry), then plan again.",
      details: { path: layout.entry, conflict: "missing-file" },
    });
  }
  const analysis = analyzeEntry(entryText, layout.entry);
  await builder.editFile({
    path: layout.entry,
    edit: importsEdit(analysis.style),
    description: `import the auth and notes routes in ${layout.entry} (managed region ${IMPORTS_REGION})`,
    owns: [IMPORTS_REGION],
    createIfMissing: false,
  });
  await builder.editFile({
    path: layout.entry,
    edit: routesEdit(analysis),
    description: `mount /api/auth and /api/notes on ${analysis.appVar} in ${layout.entry} (managed region ${ROUTES_REGION})`,
    owns: [ROUTES_REGION],
    createIfMissing: false,
  });
  return {
    analysis,
    artifacts: [
      await regionArtifact(builder, schemaPath, [SCHEMA_REGION_ID]),
      await regionArtifact(builder, layout.entry, [IMPORTS_REGION, ROUTES_REGION]),
    ],
  };
}

async function planProjectFiles(
  input: RecipePlanInput,
  layout: RecipeLayout,
  url: string,
): Promise<boolean> {
  const { builder, root } = input;
  const scriptKeys = await ensureScripts(builder, layout, authScripts(layout), AUTH_RECIPE_ID);
  const depKeys = await addDependencies(builder, layout, [
    { name: "better-auth", version: PINS.betterAuth, dev: false },
  ]);
  builder.own({
    path: layout.packageJson,
    owner: "shared",
    parts: [...scriptKeys, ...depKeys],
    note: "auth.better-auth adds these keys; the rest of package.json is yours",
  });
  // The secret file must be ignored before anything is written into it.
  await ensureIgnored(builder, root, layout.appDir, [envLocalTarget(layout)], AUTH_RECIPE_ID);
  await addEnvExample(
    builder,
    layout,
    [
      {
        name: SECRET_NAME,
        value: "",
        comment:
          "Server-only session signing secret (>= 32 random chars, e.g. openssl rand -base64 32); Groot generates a local one into .env.local",
      },
      {
        name: "BETTER_AUTH_URL",
        value: url,
        comment: "Public origin of this API (scheme + host + port)",
      },
      {
        name: "BETTER_AUTH_TRUSTED_ORIGINS",
        value: "",
        comment: "Optional: comma-separated browser origins allowed to call this API with cookies",
      },
    ],
    AUTH_RECIPE_ID,
  );
  await addEnvLocal(
    builder,
    layout,
    [{ name: "BETTER_AUTH_URL", value: url, comment: "this API's local origin" }],
    AUTH_RECIPE_ID,
  );
  return addSecret(builder, root, layout, SECRET_NAME);
}

interface AuthPlan {
  readonly artifacts: OwnedArtifact[];
  readonly analysis: EntryAnalysis;
  readonly url: string;
  /** false when the developer's existing secret was kept. */
  readonly generated: boolean;
}

function decisions(input: RecipePlanInput, layout: RecipeLayout, plan: AuthPlan): Decision[] {
  const app = input.target.app;
  const decision = (topic: string, value: string, rationale: string): Decision =>
    recipeDecision({
      recipe: AUTH_RECIPE_ID,
      version: AUTH_RECIPE_VERSION,
      app: app.id,
      topic,
      value,
      rationale,
      at: input.builder.createdAt,
    });
  const portSource =
    app.port === null ? "Bun's default port — groot.json records none" : "groot.json";
  const kept = decision(
    "auth.secret",
    `kept the existing ${SECRET_NAME} in ${layout.envLocal}`,
    "Groot never replaces a secret the developer already set.",
  );
  return [
    decision(
      "auth.method",
      `email + password via Better Auth ${PINS.betterAuth}; cookie sessions stored through Drizzle; email verification off`,
      "The certified composition: fully local, no provider account, verifiable end to end over HTTP.",
    ),
    decision(
      "auth.routes",
      `Better Auth at /api/auth and per-user notes (the protected example) at /api/notes, mounted on ${plan.analysis.appVar} in ${layout.entry}`,
      "Better Auth's default basePath; the notes routes prove the authorization boundary.",
    ),
    decision(
      "auth.origin",
      `BETTER_AUTH_URL=${plan.url} (port from ${portSource})`,
      "Better Auth trusts this origin for Origin checks; it must match where the app serves.",
    ),
    ...(plan.generated ? [] : [kept]),
  ];
}

function contribution(
  input: RecipePlanInput,
  layout: RecipeLayout,
  plan: AuthPlan,
): RecipeContribution {
  const { builder } = input;
  const app = input.target.app;
  const capability: BlueprintCapability = {
    id: "auth",
    recipe: AUTH_RECIPE_ID,
    recipeVersion: AUTH_RECIPE_VERSION,
    target: app.id,
    options: {},
    addedBy: builder.planId,
    addedAt: builder.createdAt,
  };
  const lock: RecipeLock = {
    capability: "auth",
    recipe: AUTH_RECIPE_ID,
    recipeVersion: AUTH_RECIPE_VERSION,
    target: app.id,
    appliedBy: builder.planId,
    plannedAt: builder.createdAt,
    dependencies: { "better-auth": PINS.betterAuth },
    artifacts: plan.artifacts,
  };
  return {
    capability,
    env: envFor(AUTH_DESCRIPTOR.env, layout, { BETTER_AUTH_URL: plan.url }),
    verification: verificationFor(AUTH_DESCRIPTOR.verification, app),
    lock,
    decisions: decisions(input, layout, plan),
  };
}

async function planAuth(input: RecipePlanInput): Promise<RecipeContribution> {
  const { builder, target } = input;
  const derived = requireLayout(target, AUTH_RECIPE_ID);
  // Data planned earlier in this operation publishes its layout; otherwise it is derived the same way.
  const layout =
    (input.shared.get(dataLayoutKey(target.app.id)) as RecipeLayout | undefined) ?? derived;
  const journal = await requireDataLayer(builder, layout);
  journalState(journal, layout.journal);
  await assertUntracked(input.root, layout.envLocal, AUTH_RECIPE_ID);
  const owned = await planModules(builder, layout);
  await planJournal(builder, layout, journal);
  const regions = await planRegions(builder, layout);
  const url = localAuthUrl(appPort(target.app));
  const generated = await planProjectFiles(input, layout, url);
  return contribution(input, layout, {
    artifacts: [...owned, ...regions.artifacts],
    analysis: regions.analysis,
    url,
    generated,
  });
}

export const authBetterAuth: Recipe = {
  descriptor: AUTH_DESCRIPTOR,
  compatibility: (target) => layoutCompatibility(target, AUTH_RECIPE_ID),
  plan: planAuth,
};
