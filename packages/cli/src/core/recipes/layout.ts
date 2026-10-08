/**
 * Where the auth/data recipes put things inside a target app.
 *
 * Everything hangs off the app's server entry (BlueprintApp.entry, relative to
 * the app — the convention discovery uses): recipe modules go next to it
 * (`src/` for create-hono layouts, `server/` for an adopted project whose
 * entry is server/main.ts), while app-level tooling (drizzle.config.ts,
 * drizzle/, env files) sits at the app root, which is where `bun run` and
 * drizzle-kit execute. Both recipes and the checkers derive paths from this
 * one function so they can never disagree about a layout.
 */
import { posix } from "node:path";
import type { BlueprintApp } from "../contracts/blueprint.ts";
import type { ProjectUnit } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { joinRel } from "../fs/paths.ts";
import type { RecipeTarget } from "./types.ts";

export interface RecipeLayout {
  /** The app's unit path ("." or "apps/api"). */
  readonly appDir: string;
  /** Entry relative to the app ("src/index.ts"). */
  readonly entryInApp: string;
  /** Source directory relative to the app ("src", "server", or "."). */
  readonly srcInApp: string;
  /** Project-relative paths. */
  readonly entry: string;
  readonly src: string;
  readonly db: string;
  readonly http: string;
  readonly drizzle: string;
  readonly journal: string;
  readonly packageJson: string;
  readonly envLocal: string;
  readonly envExample: string;
  /** Relative path from <src>/db to the app's drizzle/ folder (migrate.ts resolves migrations with it). */
  readonly migrationsFromDb: string;
  /** Path drizzle-kit reads the schema from, relative to the app ("./src/db/schema.ts"). */
  readonly schemaForKit: string;
}

/** The server entry a recipe mounts into (blueprint first, then discovery). */
export function entryOf(app: BlueprintApp, unit: ProjectUnit | undefined): string | null {
  return app.entry ?? unit?.entry.value ?? null;
}

export function recipeLayout(
  app: BlueprintApp,
  unit: ProjectUnit | undefined,
): RecipeLayout | null {
  const entryInApp = entryOf(app, unit);
  if (entryInApp === null) return null;
  const appDir = app.path;
  const srcInApp = posix.dirname(entryInApp);
  const inApp = (...parts: string[]): string => joinRel(appDir, ...parts);
  const dbInApp = posix.join(srcInApp, "db");
  return {
    appDir,
    entryInApp,
    srcInApp,
    entry: inApp(entryInApp),
    src: inApp(srcInApp),
    db: inApp(dbInApp),
    http: inApp(srcInApp, "http"),
    drizzle: inApp("drizzle"),
    journal: inApp("drizzle", "meta", "_journal.json"),
    packageJson: inApp("package.json"),
    envLocal: inApp(".env.local"),
    envExample: inApp(".env.example"),
    migrationsFromDb: posix.relative(dbInApp, "drizzle"),
    schemaForKit: `./${posix.join(dbInApp, "schema.ts")}`,
  };
}

/** A script path relative to the app ("src/db/migrate.ts"). */
export function inSrc(layout: RecipeLayout, ...parts: string[]): string {
  return posix.join(layout.srcInApp, ...parts);
}

/**
 * A path as one word of a package.json script — bun runs scripts through
 * bash/sh/zsh (Bun's shell on Windows), all of which take single quotes
 * literally. layoutCompatibility() refuses directories a quote can't carry.
 */
export function scriptWord(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path}'`;
}

/**
 * Port the app serves on in development (BETTER_AUTH_URL must match it).
 * Bun serves default-export apps on 3000 when nothing else is recorded.
 */
export const BUN_DEFAULT_PORT = 3000;

export function appPort(app: BlueprintApp): number {
  return app.port ?? BUN_DEFAULT_PORT;
}

const TS_ENTRY = /\.(?:[cm]?ts|tsx)$/;

/**
 * Characters the entry's directory may use: its paths go into package.json
 * scripts (quoted by scriptWord), TypeScript string literals, and
 * drizzle-kit's schema option, which is a glob — so no quotes, no shell or
 * glob metacharacters.
 */
const EXPRESSIBLE_DIR = /^[\p{L}\p{N} ._@+/-]+$/u;

/**
 * Why a recipe can't target this app (empty = compatible). The solver already
 * matched kind/framework/topology from the descriptor; these are the
 * layout-level facts the descriptor can't express.
 */
export function layoutCompatibility(target: RecipeTarget, recipeId: string): string[] {
  const reasons: string[] = [];
  const entry = entryOf(target.app, target.unit);
  if (entry === null) {
    reasons.push(
      `${target.app.id} has no recorded server entry (apps[].entry in groot.json); ${recipeId} places its modules next to it`,
    );
  } else if (!TS_ENTRY.test(entry)) {
    reasons.push(
      `${target.app.id}'s entry ${entry} is not TypeScript; ${recipeId} ships TypeScript modules`,
    );
  } else if (!EXPRESSIBLE_DIR.test(posix.dirname(entry))) {
    reasons.push(
      `${target.app.id}'s entry directory "${posix.dirname(entry)}" has characters ${recipeId} can't write safely into package.json scripts, TypeScript string literals, and drizzle-kit's schema glob (letters, digits, spaces, and . _ - @ + are fine)`,
    );
  }
  if (target.unit?.runtime.value === "node") {
    reasons.push(
      `${target.unit.path} runs on Node.js; ${recipeId} needs the Bun runtime (bun:sqlite)`,
    );
  }
  return reasons;
}

/** The layout for a target the solver accepted; a recipe planned outside the solver still fails loudly. */
export function requireLayout(target: RecipeTarget, recipeId: string): RecipeLayout {
  const reasons = layoutCompatibility(target, recipeId);
  const layout = recipeLayout(target.app, target.unit);
  if (reasons.length > 0 || layout === null) {
    throw new GrootV2Error(
      "GROOT_E_INCOMPATIBLE",
      `${recipeId} cannot target ${target.app.id}: ${reasons.join("; ")}.`,
      {
        details: { recipe: recipeId, app: target.app.id, reasons },
      },
    );
  }
  return layout;
}
