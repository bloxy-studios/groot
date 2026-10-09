/**
 * What the recipes ship, checked offline: descriptors satisfy the recipe
 * contract with exact pins and sound env contracts; the static migrations
 * chain like drizzle-kit's own output and their SQL really builds the schema
 * (foreign keys enforced); every TypeScript template parses; layouts resolve
 * paths for each supported entry shape.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RecipeDescriptor } from "../contracts/capability.ts";
import { envContractViolations } from "../env.ts";
import { appFixture } from "../test-fixtures.ts";
import { applyEdit } from "../transforms/index.ts";
import { AUTH_DESCRIPTOR } from "./auth/descriptor.ts";
import * as authTemplates from "./auth/templates.ts";
import { DATA_DESCRIPTOR } from "./data/descriptor.ts";
import * as dataTemplates from "./data/templates.ts";
import { recipeLayout } from "./layout.ts";
import { AUTH_MIGRATION, DATA_MIGRATION, journalFile, snapshotFile } from "./migrations.ts";
import { CERTIFICATION, RECIPE_SUPPORT } from "./versions.ts";

const EXACT = /^\d+\.\d+\.\d+$/;

describe("descriptors", () => {
  test.each([
    DATA_DESCRIPTOR,
    AUTH_DESCRIPTOR,
  ])("$id satisfies the recipe contract with exact pins", (descriptor) => {
    // Act
    const parsed = RecipeDescriptor.safeParse(descriptor);
    // Assert
    expect(parsed.success).toBe(true);
    for (const version of [
      ...Object.values(descriptor.dependencies),
      ...Object.values(descriptor.devDependencies),
    ]) {
      expect(version).toMatch(EXACT);
    }
    expect(descriptor.targets).toEqual({
      kinds: ["api"],
      frameworks: ["hono"],
      runtimes: ["bun"],
      topologies: ["single", "monorepo"],
    });
  });

  test("env contracts are sound once placed in an app", () => {
    // Arrange
    const placed = [...DATA_DESCRIPTOR.env, ...AUTH_DESCRIPTOR.env].map((env) => ({
      ...env,
      consumer: "apps/api",
      storage: "apps/api/.env.local",
    }));
    // Act
    const violations = envContractViolations(placed);
    // Assert
    expect(violations).toEqual([]);
    expect(placed.filter((env) => env.sensitivity === "secret").map((env) => env.name)).toEqual([
      "BETTER_AUTH_SECRET",
    ]);
    expect(placed.find((env) => env.name === "BETTER_AUTH_SECRET")?.example).toBe("");
  });

  test("auth requires data through data.drizzle-sqlite and refuses other auth/data stacks", () => {
    // Assert
    expect(AUTH_DESCRIPTOR.requires).toEqual([
      { capability: "data", recipes: ["data.drizzle-sqlite"] },
    ]);
    expect(AUTH_DESCRIPTOR.conflicts.map((c) => c.dependency)).toEqual([
      "better-auth",
      "next-auth",
      "@auth/core",
      "lucia",
      "@clerk/backend",
      "@clerk/clerk-sdk-node",
    ]);
    expect(DATA_DESCRIPTOR.conflicts.map((c) => c.dependency)).toEqual([
      "drizzle-orm",
      "prisma",
      "@prisma/client",
      "kysely",
      "typeorm",
      "mongoose",
    ]);
  });

  test("support is 'certified' only together with a certification record", () => {
    // Assert
    for (const descriptor of [DATA_DESCRIPTOR, AUTH_DESCRIPTOR]) {
      expect(descriptor.support).toBe(RECIPE_SUPPORT);
      expect(descriptor.certification).toEqual(CERTIFICATION);
    }
    expect(RECIPE_SUPPORT === "certified").toBe(CERTIFICATION !== null);
  });
});

describe("static migrations", () => {
  test("snapshots chain like drizzle-kit's: 0000 from the empty root, 0001 from 0000", () => {
    // Act
    const data = JSON.parse(DATA_MIGRATION.snapshot);
    const auth = JSON.parse(AUTH_MIGRATION.snapshot);
    // Assert
    expect(data.prevId).toBe("00000000-0000-0000-0000-000000000000");
    expect(auth.prevId).toBe(data.id);
    expect(Object.keys(data.tables)).toEqual(["todos"]);
    expect(Object.keys(auth.tables).sort()).toEqual([
      "account",
      "notes",
      "session",
      "todos",
      "user",
      "verification",
    ]);
    expect([DATA_MIGRATION.entry.idx, AUTH_MIGRATION.entry.idx]).toEqual([0, 1]);
    expect(DATA_MIGRATION.entry.when).toBeLessThan(AUTH_MIGRATION.entry.when);
  });

  test("auth's journal edit on data's journal yields exactly drizzle-kit's two-entry journal", () => {
    // Arrange
    const dataJournal = journalFile([DATA_MIGRATION.entry]);
    // Act
    const edited = applyEdit(
      dataJournal,
      {
        kind: "json",
        ops: [{ op: "append-unique", pointer: "/entries", value: AUTH_MIGRATION.entry }],
      },
      "drizzle/meta/_journal.json",
    );
    // Assert
    expect(dataJournal.endsWith("\n")).toBe(false);
    expect(edited).toBe(journalFile([DATA_MIGRATION.entry, AUTH_MIGRATION.entry]));
    expect(snapshotFile(AUTH_MIGRATION)).toBe(
      JSON.stringify(JSON.parse(AUTH_MIGRATION.snapshot), null, 2),
    );
  });

  test("the SQL builds the schema in SQLite, with per-user foreign keys enforced", () => {
    // Arrange
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON;");
    // Act
    for (const migration of [DATA_MIGRATION, AUTH_MIGRATION]) {
      for (const statement of migration.sql.split("--> statement-breakpoint")) db.run(statement);
    }
    // Assert
    const tables = (
      db.query("select name from sqlite_master where type = 'table' order by name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(["account", "notes", "session", "todos", "user", "verification"]);
    expect(() =>
      db.run("insert into notes (id, user_id, body, created_at) values ('n1', 'nobody', 'x', 0)"),
    ).toThrow(/FOREIGN KEY/);
    db.run(
      "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'A', 'a@x.test', 0, 0, 0)",
    );
    db.run("insert into notes (id, user_id, body, created_at) values ('n1', 'u1', 'x', 0)");
    db.run("delete from user where id = 'u1'");
    expect((db.query("select count(*) as n from notes").get() as { n: number }).n).toBe(0);
  });
});

const serverLayout = recipeLayout(
  appFixture({ id: "api", path: ".", entry: "server/main.ts" }),
  undefined,
);
if (serverLayout === null) throw new Error("fixture layout must resolve");
const TS_TEMPLATES: [string, string][] = [
  ...Object.entries(authTemplates).filter(([name]) => name.endsWith("_TS")),
  ["SQLITE_TS", dataTemplates.SQLITE_TS],
  ["CLIENT_TS", dataTemplates.CLIENT_TS],
  ["SCHEMA_TS", dataTemplates.SCHEMA_TS],
  ["migrateTs(server/)", dataTemplates.migrateTs(serverLayout)],
  ["drizzleConfigTs(server/)", dataTemplates.drizzleConfigTs(serverLayout)],
];

describe("templates", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  test.each(TS_TEMPLATES)("%s parses as TypeScript", (_name, source) => {
    // Act + Assert
    expect(() => transpiler.transformSync(source)).not.toThrow();
  });

  test("recipe-owned modules name their recipe; the generated auth schema stays verbatim", () => {
    // Assert
    for (const source of [
      dataTemplates.SQLITE_TS,
      dataTemplates.CLIENT_TS,
      authTemplates.AUTH_TS,
    ]) {
      expect(source).toMatch(/Groot recipe (data\.drizzle-sqlite|auth\.better-auth)/);
    }
    expect(
      authTemplates.AUTH_SCHEMA_TS.startsWith('import { relations } from "drizzle-orm";'),
    ).toBe(true);
  });
});

describe("layouts", () => {
  test.each([
    [".", "src/index.ts", "src/db", "src/http", "drizzle", "../../drizzle", "./src/db/schema.ts"],
    [
      ".",
      "server/main.ts",
      "server/db",
      "server/http",
      "drizzle",
      "../../drizzle",
      "./server/db/schema.ts",
    ],
    [
      "apps/api",
      "src/index.ts",
      "apps/api/src/db",
      "apps/api/src/http",
      "apps/api/drizzle",
      "../../drizzle",
      "./src/db/schema.ts",
    ],
    [".", "index.ts", "db", "http", "drizzle", "../drizzle", "./db/schema.ts"],
    [
      ".",
      "src/server/app.ts",
      "src/server/db",
      "src/server/http",
      "drizzle",
      "../../../drizzle",
      "./src/server/db/schema.ts",
    ],
  ])("app %s with entry %s", (path, entry, db, http, drizzle, fromDb, kit) => {
    // Act
    const layout = recipeLayout(appFixture({ id: "api", path, entry }), undefined);
    // Assert
    expect(layout).toMatchObject({
      db,
      http,
      drizzle,
      migrationsFromDb: fromDb,
      schemaForKit: kit,
    });
  });
});
