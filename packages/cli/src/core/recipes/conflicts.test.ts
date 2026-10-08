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
import { observeUnit } from "./testing/plan.ts";
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
