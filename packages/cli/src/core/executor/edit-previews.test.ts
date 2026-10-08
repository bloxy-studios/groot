/**
 * Builder previews meet the executor: edits the builder defers (after a
 * deps.add, a generated secret, or a deferred edit of the same file) are
 * computed at apply time so no earlier change is lost, and secret-bearing
 * dotenv edits apply their entries without any value reaching a plan, a
 * saved plan, or the journal.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { canonicalJson } from "../json.ts";
import { applyPlan, loadPlanFile, savePlan } from "./index.ts";
import {
  addDeps,
  addSecret,
  anyFileContains,
  buildPlan,
  operationDir,
  permissive,
  scratchProject,
  testContext,
} from "./test-support.ts";

const DB_PASSWORD = "Pg-Pr0d-Passw0rd";
const STRIPE_KEY = "rk_live_51HsecretStripeKey";
const ENV_LOCAL = `DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/app\nSTRIPE_SECRET_KEY=${STRIPE_KEY}\n`;

describe("deferred edits land on top of earlier changes", () => {
  test("deps.add followed by a package.json script edit applies both", async () => {
    // Arrange
    const root = scratchProject({
      "package.json": '{\n  "name": "app",\n  "dependencies": {\n    "hono": "4.9.0"\n  }\n}\n',
    });
    const plan = await buildPlan(root, async (b) => {
      await addDeps(b, [{ package: "drizzle-orm", to: "0.44.0", dev: false }]);
      await b.editFile({
        path: "package.json",
        edit: {
          kind: "json",
          ops: [{ op: "set", pointer: "/scripts/db:migrate", value: "bun run src/db/migrate.ts" }],
        },
        description: "add db:migrate",
        owns: [],
        createIfMissing: false,
      });
    });

    // Act
    const result = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Assert
    expect(result.status).toBe("completed");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      name: "app",
      dependencies: { "drizzle-orm": "0.44.0", hono: "4.9.0" },
      scripts: { "db:migrate": "bun run src/db/migrate.ts" },
    });
  });

  test("write, deferred edit, edit: every line lands", async () => {
    // Arrange
    const root = scratchProject();
    const append = (line: string, deferred: boolean) => ({
      path: "notes.txt",
      edit: { kind: "lines" as const, lines: [line], header: null },
      description: `append ${line}`,
      owns: [],
      createIfMissing: false,
      deferred,
    });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "notes.txt", content: "one\n", description: "write notes" });
      await b.editFile(append("two", true));
      await b.editFile(append("three", false));
    });

    // Act
    await applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" });

    // Assert
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("one\n\ntwo\n\nthree\n");
  });
});

describe("an env edit after a generated secret in the same file", () => {
  test.each([
    ["an existing", { ".env.local": "PORT=3000\n" }, "PORT=3000\n\n"],
    ["a missing", {}, ""],
  ])("%s .env.local ends with both entries; the secret stays out of .groot", async (_label, files, before) => {
    // Arrange
    const root = scratchProject(files);
    const plan = await buildPlan(root, async (b) => {
      addSecret(b, ".env.local", "BETTER_AUTH_SECRET");
      await b.editFile({
        path: ".env.local",
        edit: {
          kind: "env",
          entries: [{ name: "BETTER_AUTH_URL", value: "http://localhost:3000", comment: null }],
        },
        description: "add BETTER_AUTH_URL",
        owns: [],
        createIfMissing: true,
      });
    });

    // Act
    const result = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Assert
    expect(result.status).toBe("completed");
    const env = readFileSync(join(root, ".env.local"), "utf8");
    const secret = /^BETTER_AUTH_SECRET=(\S+)$/m.exec(env)?.[1] ?? "";
    expect(secret).toHaveLength(43);
    expect(env).toBe(
      `${before}BETTER_AUTH_SECRET=${secret}\n\nBETTER_AUTH_URL=http://localhost:3000\n`,
    );
    expect(anyFileContains(join(root, ".groot"), secret)).toBeNull();
  });
});

describe("dotenv edits never carry values", () => {
  test("an env edit adds its entry, keeps existing ones, and no value reaches plans or the journal", async () => {
    // Arrange
    const root = scratchProject({ "apps/web/.env.local": ENV_LOCAL });
    const plan = await buildPlan(root, async (b) => {
      await b.editFile({
        path: "apps/web/.env.local",
        edit: {
          kind: "env",
          entries: [{ name: "BETTER_AUTH_URL", value: "http://localhost:3000", comment: null }],
        },
        description: "add BETTER_AUTH_URL",
        owns: [],
        createIfMissing: false,
      });
    });
    const saved = await savePlan(root, plan);

    // Act
    const result = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Assert
    expect(result.status).toBe("completed");
    expect(readFileSync(join(root, "apps/web/.env.local"), "utf8")).toBe(
      `${ENV_LOCAL}\nBETTER_AUTH_URL=http://localhost:3000\n`,
    );
    const opDir = operationDir(root, result.operationId);
    for (const file of [
      saved,
      join(opDir, "plan.json"),
      join(opDir, "journal.jsonl"),
      join(opDir, "state.json"),
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(DB_PASSWORD);
      expect(text).not.toContain(STRIPE_KEY);
    }
    expect(JSON.stringify(result)).not.toContain(DB_PASSWORD);
  });

  test("a plan document that carries dotenv contents is refused", async () => {
    // Arrange
    const root = scratchProject({ ".env.local": ENV_LOCAL });
    const plan = await buildPlan(root, async (b) => {
      await b.editFile({
        path: ".env.local",
        edit: { kind: "env", entries: [{ name: "PORT", value: "3000", comment: null }] },
        description: "add PORT",
        owns: [],
        createIfMissing: false,
      });
    });
    const forged = JSON.parse(JSON.stringify(plan));
    const content = `${ENV_LOCAL}\nPORT=3000\n`;
    forged.actions[0].after = { content, sha256: sha256Of(content) };
    forged.fingerprint = sha256Of(
      canonicalJson({
        intent: forged.intent,
        actions: forged.actions,
        preconditions: forged.preconditions,
      }),
    );
    const file = join(root, "forged-plan.json");
    writeFileSync(file, JSON.stringify(forged));

    // Act
    let error: unknown;
    try {
      await loadPlanFile(file);
    } catch (caught) {
      error = caught;
    }

    // Assert
    expect(error).toBeInstanceOf(GrootV2Error);
    expect((error as GrootV2Error).id).toBe("GROOT_E_INVALID_DOCUMENT");
    const issues = ((error as GrootV2Error).details?.issues ?? []) as { path: string }[];
    expect(issues.map((issue) => issue.path)).toEqual(["actions.0.after"]);
  });
});
