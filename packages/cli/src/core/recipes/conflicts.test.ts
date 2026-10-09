/**
 * The recipes refuse instead of guessing: missing or ambiguous anchors,
 * chained declarations, files and scripts that already exist with other
 * content, a migration journal that moved on, and a tracked env file are all
 * precise GROOT_E_CONFLICT errors; an existing secret is kept, never replaced
 * or copied into the plan; and auth planned after data (separately) builds on
 * the applied data layer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { fixtureFact, unitFixture } from "../test-fixtures.ts";
import { removeRegion } from "../transforms/index.ts";
import { authBetterAuth } from "./auth/recipe.ts";
import { dataDrizzleSqlite } from "./data/recipe.ts";
import { materializePlan } from "./testing/apply.ts";
import {
  BOTH,
  type PlanningFixture,
  planBoth,
  removeScratchDirs,
  singleApp,
} from "./testing/fixtures.ts";
import { observeUnit, type PlannedRecipes } from "./testing/plan.ts";
import { commitAll } from "./testing/projects.ts";
import type { Recipe } from "./types.ts";

const TIMEOUT = 60_000;

afterAll(removeScratchDirs);

async function planError(
  fx: PlanningFixture,
  recipes: readonly Recipe[] = BOTH,
): Promise<GrootV2Error> {
  try {
    await planBoth(fx, recipes);
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
  throw new Error("expected planning to fail");
}

const writeEntry = (text: string) => (root: string) =>
  writeFileSync(join(root, "src/index.ts"), text);

describe("entry anchors", () => {
  test(
    'no `import { Hono } from "hono"` statement → conflict naming the anchor',
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          'import * as hono from "hono";\nconst app = new hono.Hono();\nexport default app;\n',
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain('could not find the `import { Hono } from "hono"` statement');
      expect(error.details).toMatchObject({ path: "src/index.ts", conflict: "transform" });
    },
    TIMEOUT,
  );

  test(
    "two `new Hono(` declarations → conflict, never a guess",
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          'import { Hono } from "hono";\nconst app = new Hono();\nconst admin = new Hono();\napp.route("/admin", admin);\nexport default app;\n',
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain(
        "found 2 candidates for the `const app = new Hono()` declaration (lines 2, 3)",
      );
    },
    TIMEOUT,
  );

  test(
    "a declaration continued by chained calls → conflict (a region there would split the expression)",
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          'import { Hono } from "hono";\nconst app = new Hono()\n  .get("/", (c) => c.text("hi"));\nexport default app;\n',
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain("continues with chained calls");
      expect(error.hint).toContain("const app = new Hono();");
    },
    TIMEOUT,
  );

  test.each([
    [
      "semicolons",
      'import { Hono } from "hono";\nimport { logger } from "hono/logger";\n\nconst app = new Hono()\n  // request logging first\n  .use(logger());\n\nexport default app;\n',
    ],
    [
      "no semicolons",
      "import { Hono } from 'hono'\nimport { logger } from 'hono/logger'\n\nconst app = new Hono()\n  // request logging first\n  .use(logger())\n\nexport default app\n",
    ],
  ])(
    "a comment line inside the declaration's chain (%s) → conflict, the chain is never split",
    async (_style, entry) => {
      // Arrange
      const fx = await singleApp(writeEntry(entry));
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain("declaration on line 4 continues with chained calls");
      expect(error.details).toMatchObject({ path: "src/index.ts", conflict: "transform" });
    },
    TIMEOUT,
  );

  test(
    "a JSDoc with an apostrophe inside the declaration's chain → conflict",
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          "import { Hono } from \"hono\";\n\nconst app = new Hono()\n  /**\n   * Don't drop the logger: it's the audit trail.\n   */\n  .use(async (_c, next) => next());\n\nexport default app;\n",
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain("continues with chained calls");
    },
    TIMEOUT,
  );

  test(
    "a JSDoc with an apostrophe inside a multi-line declaration never gets a region inside it",
    async () => {
      // Arrange
      const entry =
        "import { Hono } from \"hono\";\n\nconst app = new Hono<{\n  /** The request's id (don't trust the client's). */\n  Variables: { id: string };\n}>();\n\nexport default app;\n";
      const fx = await singleApp(writeEntry(entry));
      // Act
      let planned: PlannedRecipes;
      try {
        planned = await planBoth(fx);
      } catch (error) {
        // Assert (refused): the statement couldn't be read the same way the transform reads it.
        expect(error).toBeInstanceOf(GrootV2Error);
        expect((error as GrootV2Error).id).toBe("GROOT_E_CONFLICT");
        expect((error as GrootV2Error).details).toMatchObject({
          path: "src/index.ts",
          reason: "region placement",
        });
        return;
      }
      // Assert (planned): mounted right after `}>();` — never inside the type argument.
      await materializePlan(fx.root, planned.plan);
      const mounted = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(mounted).toContain("}>();\n// groot:begin auth.routes");
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(mounted)).not.toThrow();
    },
    TIMEOUT,
  );

  test(
    "closing brackets in a regular expression inside the Hono options never get a region inside the declaration",
    async () => {
      // Arrange
      const entry =
        'import { Hono } from "hono";\n\nconst app = new Hono({\n  getPath: (req) => {\n    const path = new URL(req.url).pathname.replace(/[)}\\]]+$/, "")\n    return path\n  },\n});\n\napp.get("/", (c) => c.text("hi"));\n\nexport default app;\n';
      const fx = await singleApp(writeEntry(entry));
      // Act
      let planned: PlannedRecipes;
      try {
        planned = await planBoth(fx);
      } catch (error) {
        // Assert (refused): the transform reads that statement differently, so it's never guessed.
        expect(error).toBeInstanceOf(GrootV2Error);
        expect((error as GrootV2Error).id).toBe("GROOT_E_CONFLICT");
        expect((error as GrootV2Error).details).toMatchObject({
          path: "src/index.ts",
          conflict: "transform",
        });
        return;
      }
      // Assert (planned): mounted after the declaration's closing line, never inside getPath.
      await materializePlan(fx.root, planned.plan);
      const mounted = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(mounted).toContain("  },\n});\n// groot:begin auth.routes");
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(mounted)).not.toThrow();
    },
    TIMEOUT,
  );

  test(
    "a statement the recipe and the transform both misread can't put a region inside a function: the entry must keep it top-level",
    async () => {
      // Arrange — `/` after `)` reads as a division to both, so the regex's closers end the statement early.
      const fx = await singleApp(
        writeEntry(
          'import { Hono } from "hono";\n\nconst app = new Hono({\n  getPath: (req) => {\n    if (req.url) /[)}\\]]+$/.test(req.url)\n    return new URL(req.url).pathname\n  },\n});\n\nexport default app;\n',
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details).toMatchObject({
        path: "src/index.ts",
        conflict: "transform",
        reason: "region not at top level",
      });
    },
    TIMEOUT,
  );

  test(
    "a regular expression in the Hono options with balanced brackets is mounted after the declaration",
    async () => {
      // Arrange — Hono's documented getPath example.
      const entry =
        'import { Hono } from "hono";\n\nconst app = new Hono({\n  getPath: (req) => req.url.replace(/^https?:\\/\\/[^/]+(\\/[^?]*)/, "$1"),\n});\n\nexport default app;\n';
      const fx = await singleApp(writeEntry(entry));
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const mounted = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(mounted).toContain('"$1"),\n});\n// groot:begin auth.routes');
      expect(removeRegion(removeRegion(mounted, "auth.imports", "e"), "auth.routes", "e")).toBe(
        entry,
      );
    },
    TIMEOUT,
  );

  test(
    'a formatter\'s multi-line `import {\\n  Hono,\\n} from "hono"` is anchored on its closing line',
    async () => {
      // Arrange
      const entry =
        'import {\n  Hono,\n  type Context,\n} from "hono";\n\nconst app = new Hono();\n\napp.get("/", (c: Context) => c.text("hi"));\n\nexport default app;\n';
      const fx = await singleApp(writeEntry(entry));
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const mounted = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(mounted).toContain('} from "hono";\n// groot:begin auth.imports');
      expect(mounted).toContain('import { authRoutes } from "./http/auth-routes";\n');
      expect(mounted).toContain("const app = new Hono();\n// groot:begin auth.routes");
      expect(removeRegion(removeRegion(mounted, "auth.imports", "e"), "auth.routes", "e")).toBe(
        entry,
      );
    },
    TIMEOUT,
  );

  test(
    'two multi-line imports closing on `} from "hono"` → conflict naming both lines',
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          'import type {\n  Context,\n} from "hono";\nimport {\n  Hono,\n} from "hono";\n\nconst app = new Hono();\nexport default app;\n',
        ),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain(
        'found 2 candidates for the closing `} from "hono"` line of the multi-line Hono import (lines 3, 6)',
      );
    },
    TIMEOUT,
  );

  test(
    "a multi-line declaration is mounted after its closing line",
    async () => {
      // Arrange
      const fx = await singleApp(
        writeEntry(
          'import { Hono } from "hono";\n\nconst app = new Hono<{\n  Variables: { id: string };\n}>();\n\nexport default app;\n',
        ),
      );
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const entry = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(entry).toContain("}>();\n// groot:begin auth.routes");
    },
    TIMEOUT,
  );
});

describe("existing human files and scripts", () => {
  test(
    "a different src/auth.ts already exists → conflict, the file is never overwritten",
    async () => {
      // Arrange
      const fx = await singleApp((root) =>
        writeFileSync(join(root, "src/auth.ts"), "export const auth = 'mine';\n"),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details).toMatchObject({ path: "src/auth.ts", conflict: "file-exists" });
      expect(readFileSync(join(fx.root, "src/auth.ts"), "utf8")).toBe(
        "export const auth = 'mine';\n",
      );
    },
    TIMEOUT,
  );

  test(
    "a db:migrate script with other content → conflict naming the script",
    async () => {
      // Arrange
      const fx = await singleApp((root) => {
        const path = join(root, "package.json");
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(
          path,
          JSON.stringify(
            { ...pkg, scripts: { ...pkg.scripts, "db:migrate": "prisma migrate deploy" } },
            null,
            2,
          ),
        );
      });
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain(
        'already defines the "db:migrate" script as "prisma migrate deploy"',
      );
      expect(error.details).toMatchObject({ conflict: "script", script: "db:migrate" });
    },
    TIMEOUT,
  );

  test(
    "a tracked .env.local → conflict: Groot won't write config or secrets into a committed file",
    async () => {
      // Arrange
      const fx = await singleApp((root) =>
        writeFileSync(join(root, ".env.local"), "FEATURE_FLAG=on\n"),
      );
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details).toMatchObject({ path: ".env.local", conflict: "tracked-env-file" });
      expect(error.hint).toContain("git rm --cached .env.local");
    },
    TIMEOUT,
  );

  test(
    "the developer's existing secret is kept: no env.secret step, no value of theirs in the plan",
    async () => {
      // Arrange
      const fx = await singleApp();
      writeFileSync(
        join(fx.root, ".env.local"),
        "BETTER_AUTH_SECRET=developer-chosen-secret-value-1234567890\nSTRIPE_SECRET_KEY=sk_test_abcdefghijklmnopqrstuvwxyz\n",
      );
      // Act
      const { plan, contributions } = await planBoth(fx);
      // Assert
      expect(plan.actions.some((action) => action.type === "env.secret")).toBe(false);
      const serialized = JSON.stringify(plan);
      expect(serialized).not.toContain("developer-chosen-secret-value");
      expect(serialized).not.toContain("sk_test_abcdefghijklmnopqrstuvwxyz");
      const kept = contributions[1]?.decisions.find((decision) => decision.topic === "auth.secret");
      expect(kept?.value).toBe("kept the existing BETTER_AUTH_SECRET in .env.local");
    },
    TIMEOUT,
  );

  test.each([
    ["an empty value", "BETTER_AUTH_SECRET=\n"],
    ["empty quotes", 'BETTER_AUTH_SECRET=""\n'],
    ["an exported blank", "export BETTER_AUTH_SECRET=   \n"],
    // Bun reads `#` as a comment in an unquoted value, and backticks as quotes.
    ["only a comment", "BETTER_AUTH_SECRET= # generate with openssl rand -base64 32\n"],
    ["empty quotes and a comment", 'BETTER_AUTH_SECRET="" # set me\n'],
    ["empty backticks", "BETTER_AUTH_SECRET=``\n"],
    [
      "a later blank assignment",
      "BETTER_AUTH_SECRET=an-earlier-value-0123456789abcdef\nBETTER_AUTH_SECRET=\n",
    ],
  ])(
    "a BETTER_AUTH_SECRET placeholder with %s → conflict: no plan promises a secret the executor won't write",
    async (_case, line) => {
      // Arrange
      const fx = await singleApp();
      writeFileSync(join(fx.root, ".env.local"), `FEATURE_FLAG=on\n${line}`);
      // Act
      const error = await planError(fx);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details).toMatchObject({
        path: ".env.local",
        conflict: "empty-env-value",
        name: "BETTER_AUTH_SECRET",
      });
      expect(error.hint).toContain("openssl rand -base64 32");
    },
    TIMEOUT,
  );

  test.each([
    [
      "a quoted value with # in it",
      'BETTER_AUTH_SECRET="value#with-hash-0123456789abcdef" # mine\n',
    ],
    // The executor never reads `NAME: value` as an assignment; a step would append one that wins.
    ["a `NAME: value` assignment", "BETTER_AUTH_SECRET: colon-style-value-0123456789abcdef\n"],
    ["a reference Bun expands at startup", "BETTER_AUTH_SECRET=$SHARED_AUTH_SECRET\n"],
  ])(
    "a BETTER_AUTH_SECRET Bun loads from %s is kept: no env.secret step overrides it",
    async (_case, line) => {
      // Arrange
      const fx = await singleApp();
      writeFileSync(join(fx.root, ".env.local"), `FEATURE_FLAG=on\n${line}`);
      // Act
      const { plan, contributions } = await planBoth(fx);
      // Assert
      expect(plan.actions.some((action) => action.type === "env.secret")).toBe(false);
      const kept = contributions[1]?.decisions.find((decision) => decision.topic === "auth.secret");
      expect(kept?.value).toBe("kept the existing BETTER_AUTH_SECRET in .env.local");
    },
    TIMEOUT,
  );

  test(
    "a recorded entry that doesn't exist → conflict instead of a blind edit",
    async () => {
      // Arrange
      const fx = await singleApp();
      const app = { ...fx.app, entry: "src/server.ts" };
      // Act
      const error = await planError({ ...fx, app, blueprint: { ...fx.blueprint, apps: [app] } });
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain("src/server.ts does not exist");
    },
    TIMEOUT,
  );
});

describe("compatibility and requirements", () => {
  test("no entry, a JavaScript entry, or a Node runtime are refused with reasons", () => {
    // Arrange
    const app = {
      id: "api",
      path: ".",
      kind: "api",
      framework: "hono",
      packageName: "api",
      port: 3000,
      origin: "adopted",
      entry: null,
    } as const;
    const nodeUnit = unitFixture({
      path: ".",
      runtime: fixtureFact("node" as const),
      entry: fixtureFact(null),
    });
    // Act
    const noEntry = dataDrizzleSqlite.compatibility({ app, unit: undefined }, {} as never);
    const jsEntry = authBetterAuth.compatibility(
      { app: { ...app, entry: "src/index.js" }, unit: undefined },
      {} as never,
    );
    const onNode = dataDrizzleSqlite.compatibility(
      { app: { ...app, entry: "src/index.ts" }, unit: nodeUnit },
      {} as never,
    );
    // Assert
    expect(noEntry).toEqual([
      "api has no recorded server entry (apps[].entry in groot.json); data.drizzle-sqlite places its modules next to it",
    ]);
    expect(jsEntry).toEqual([
      "api's entry src/index.js is not TypeScript; auth.better-auth ships TypeScript modules",
    ]);
    expect(onNode).toEqual([
      ". runs on Node.js; data.drizzle-sqlite needs the Bun runtime (bun:sqlite)",
    ]);
  });

  test("an entry directory that can't be written safely into scripts and literals is refused; spaces are fine", () => {
    // Arrange
    const app = {
      id: "api",
      path: ".",
      kind: "api",
      framework: "hono",
      packageName: "api",
      port: 3000,
      origin: "adopted",
      entry: null,
    } as const;
    const reasons = (entry: string): string[] =>
      dataDrizzleSqlite.compatibility({ app: { ...app, entry }, unit: undefined }, {} as never);
    // Act + Assert
    expect(reasons("it's/main.ts")).toEqual([
      `api's entry directory "it's" has characters data.drizzle-sqlite can't write safely into package.json scripts, TypeScript string literals, and drizzle-kit's schema glob (letters, digits, spaces, and . _ - @ + are fine)`,
    ]);
    expect(reasons("src/[v1]/index.ts")).toHaveLength(1);
    expect(reasons("src/$HOME/index.ts")).toHaveLength(1);
    expect(reasons('src/"q"/index.ts')).toHaveLength(1);
    expect(reasons("my server/main.ts")).toEqual([]);
    expect(reasons("index.ts")).toEqual([]);
  });

  test(
    "auth without the data layer → GROOT_E_INCOMPATIBLE naming the missing module",
    async () => {
      // Arrange
      const fx = await singleApp();
      // Act
      const error = await planError(fx, [authBetterAuth]);
      // Assert
      expect(error.id).toBe("GROOT_E_INCOMPATIBLE");
      expect(error.message).toContain(
        "auth.better-auth builds on data.drizzle-sqlite, but src/db/client.ts is missing",
      );
    },
    TIMEOUT,
  );

  test(
    "auth planned after data was applied earlier builds on it (journal edit, no data files rewritten)",
    async () => {
      // Arrange
      const fx = await singleApp();
      const first = await planBoth(fx, [dataDrizzleSqlite]);
      await materializePlan(fx.root, first.plan);
      commitAll(fx.root, "add data");
      const later = { ...fx, observation: await observeUnit(fx.root, fx.app, "single") };
      // Act
      const { plan } = await planBoth(later, [authBetterAuth]);
      // Assert
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      const touched = plan.actions.map((action) => ("path" in action ? action.path : action.type));
      expect(touched[0]).toBe("src/auth.ts");
      expect(touched).not.toContain("src/db/client.ts");
      const journal = plan.actions.find(
        (action) => action.type === "file.edit" && action.path === "drizzle/meta/_journal.json",
      );
      expect(journal?.type === "file.edit" && journal.after !== null).toBe(true);
      const scripts = plan.actions.find(
        (action) => action.type === "file.edit" && action.path === "package.json",
      );
      expect(scripts?.type === "file.edit" && scripts.after !== null).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a journal that moved on since data (a user migration) → conflict for auth's pre-generated 0001",
    async () => {
      // Arrange
      const fx = await singleApp();
      const first = await planBoth(fx, [dataDrizzleSqlite]);
      await materializePlan(fx.root, first.plan);
      const journalPath = join(fx.root, "drizzle/meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries.push({
        idx: 1,
        version: "6",
        when: 1791460000000,
        tag: "0001_user_change",
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
      const later = { ...fx, observation: await observeUnit(fx.root, fx.app, "single") };
      // Act
      const error = await planError(later, [authBetterAuth]);
      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.message).toContain("lists migrations 0000_data_init, 0001_user_change");
      expect(error.details).toMatchObject({ conflict: "migration-journal" });
    },
    TIMEOUT,
  );
});
