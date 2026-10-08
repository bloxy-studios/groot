/**
 * File templates for data.drizzle-sqlite, taken from the certified 2026-10-07
 * prototype (Bun + Hono + Drizzle ORM on bun:sqlite). Only layout-dependent
 * paths vary (written as JSON string literals, so any path stays one valid
 * literal); everything else is byte-stable, so plans preview exactly and the
 * content hashes recorded in groot.lock.json stay meaningful.
 *
 * The schema template is the source the static migration 0000 was generated
 * from (../migrations.ts) — change them together.
 */
import type { RecipeLayout } from "../layout.ts";

export const SQLITE_TS = `/**
 * Opens the app's SQLite database with bun:sqlite (Groot recipe data.drizzle-sqlite).
 *
 * DATABASE_URL accepts \`file:<path>\`, a bare path, or \`:memory:\`. Relative
 * paths resolve against the process cwd — the app directory when started with
 * \`bun run\` (also under \`bun run --filter\` and turbo).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const DEFAULT_DATABASE_URL = "./data/app.db";

export function resolveDatabasePath(url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL): string {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url;
  if (path === ":memory:") return path;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** Opens the database. Foreign keys are per-connection in SQLite, so callers choose. */
export function openSqlite({ foreignKeys }: { foreignKeys: boolean }): Database {
  const path = resolveDatabasePath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run(\`PRAGMA foreign_keys = \${foreignKeys ? "ON" : "OFF"};\`);
  return sqlite;
}
`;

export const CLIENT_TS = `/**
 * The app's Drizzle client (Groot recipe data.drizzle-sqlite). Import \`db\`
 * wherever server code reads or writes data.
 */
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { openSqlite } from "./sqlite";

export const sqlite = openSqlite({ foreignKeys: true });
export const db = drizzle({ client: sqlite, schema });
`;

/** Human-owned starter: Groot creates it once and never claims it afterwards. */
export const SCHEMA_TS = `/**
 * Your app's database schema (Drizzle ORM on SQLite). Change tables here, then
 *
 *   bun run db:generate   # write the next migration into drizzle/
 *   bun run db:migrate    # apply pending migrations
 *
 * Created by Groot (data.drizzle-sqlite) — this file is yours to edit.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Starter table — rename or remove it, then run \`bun run db:generate\`. */
export const todos = sqliteTable("todos", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
`;

export function migrateTs(layout: RecipeLayout): string {
  return `/**
 * Applies pending migrations from drizzle/: \`bun run db:migrate\`
 * (Groot recipe data.drizzle-sqlite).
 *
 * drizzle-kit rebuilds SQLite tables for many column changes (create __new_x,
 * copy, drop, rename). With foreign_keys=ON that DROP cascades into child
 * rows, and a migration's own \`PRAGMA foreign_keys=OFF\` is ignored inside the
 * migrator's transaction — so migrate with enforcement OFF, then check
 * integrity explicitly. https://www.sqlite.org/lang_altertable.html#otheralter
 */
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openSqlite } from "./sqlite";

// Resolved from this file so the script works from any cwd.
const migrationsFolder = join(import.meta.dir, ${JSON.stringify(layout.migrationsFromDb)});

const sqlite = openSqlite({ foreignKeys: false });
try {
  migrate(drizzle({ client: sqlite }), { migrationsFolder });
  const violations = sqlite.query("PRAGMA foreign_key_check;").all();
  if (violations.length > 0) {
    throw new Error(\`foreign key violations after migration: \${JSON.stringify(violations)}\`);
  }
  console.log(\`[db] migrations applied from \${migrationsFolder}\`);
} catch (error) {
  console.error("[db] migration failed:", error);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
`;
}

export function drizzleConfigTs(layout: RecipeLayout): string {
  return `/**
 * drizzle-kit configuration (Groot recipe data.drizzle-sqlite).
 * \`bun run db:generate\` diffs the schema against drizzle/meta and writes the
 * next migration; it never connects to a database.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ${JSON.stringify(layout.schemaForKit)},
  out: "./drizzle",
  // Only drizzle-kit migrate/push/studio connect; generate is fully offline.
  dbCredentials: { url: process.env.DATABASE_URL || "./data/app.db" },
});
`;
}
