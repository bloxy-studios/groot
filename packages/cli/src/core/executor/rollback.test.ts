/**
 * Rollback: byte-identical restoration (content and mode), deletion of
 * created files and directories, conflicts for later human edits (refused
 * with nothing changed), generated trees patched by later steps, secret
 * concealment in backups, the compensating install, and idempotence.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GrootV2Error } from "../errors.ts";
import { hashTree } from "../fs/hash.ts";
import { applyPlan, previewRollback, rollbackOperation } from "./index.ts";
import {
  addCommand,
  addDeps,
  addSecret,
  anyFileContains,
  buildPlan,
  journalRecords,
  MULTI_STEP_FILES,
  permissive,
  scratchProject,
  setMode,
  snapshot,
  testContext,
} from "./test-support.ts";
import { simulatedTreeHash } from "./tree-sim.ts";

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

/** The multi-step plan minus deps.add, so rollback needs no compensating install. */
async function fileOnlyPlan(root: string) {
  return buildPlan(root, async (b) => {
    await b.writeFile({
      path: "src/deep/new.ts",
      content: "export {};\n",
      description: "create src/deep/new.ts",
    });
    await b.editFile({
      path: "README.md",
      edit: { kind: "lines", lines: ["Managed by groot."], header: null },
      description: "note groot in README.md",
      owns: [],
      createIfMissing: false,
    });
    await b.editFile({
      path: "src/deep/new.ts",
      edit: { kind: "lines", lines: ["export const x = 1;"], header: null },
      description: "extend new.ts",
      owns: [],
      createIfMissing: false,
      deferred: true,
    });
    addCommand(b, "echo ran >> log.txt", { touches: ["log.txt"] });
    const { addDelete } = await import("./test-support.ts");
    await addDelete(b, "obsolete.txt");
    addSecret(b, ".env.local", "APP_SECRET");
  });
}

describe("rollback: restoration", () => {
  test("restores byte-identical content and modes, deletes created files and directories", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    setMode(root, "obsolete.txt", 0o640);
    const before = snapshot(root);
    const plan = await fileOnlyPlan(root);
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);
    const result = await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(preview.possible).toBe(true);
    expect(preview.conflicts).toEqual([]);
    expect(preview.steps.map((step) => step.stepId)).toEqual([
      "s06",
      "s05",
      "s04",
      "s03",
      "s02",
      "s01",
    ]);
    expect(result.status).toBe("rolled-back");
    expect(result.steps.every((step) => step.status === "rolled-back")).toBe(true);
    expect(snapshot(root)).toEqual(before);
    const types = journalRecords(root, applied.operationId).map((record) => record.type);
    expect(types.slice(-8)).toEqual([
      "rollback.started",
      ...Array(6).fill("rollback.step"),
      "rollback.completed",
    ]);
  });

  test("a later human edit is a conflict naming exactly that file; execution changes nothing", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await fileOnlyPlan(root);
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    writeFileSync(join(root, "README.md"), "# Demo\n\nManaged by groot.\nHuman line.\n");
    const before = snapshot(root);
    const journalBefore = journalRecords(root, applied.operationId).length;

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);
    const error = await expectGrootError(
      rollbackOperation(testContext(root).ctx, root, applied.operationId),
    );

    // Assert
    expect(preview.possible).toBe(false);
    expect(preview.conflicts).toEqual(["README.md"]);
    expect(preview.steps.find((step) => step.stepId === "s02")?.action).toBe("conflict");
    expect(preview.steps.filter((step) => step.action === "conflict")).toHaveLength(1);
    expect(error.id).toBe("GROOT_E_ROLLBACK_CONFLICT");
    expect(error.toInfo().exitCode).toBe(6);
    expect(snapshot(root)).toEqual(before);
    expect(journalRecords(root, applied.operationId)).toHaveLength(journalBefore);
  });

  test("rolling back twice is a no-op the second time", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);
    const journalLength = journalRecords(root, applied.operationId).length;

    // Act
    const again = await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(again.status).toBe("rolled-back");
    expect(journalRecords(root, applied.operationId)).toHaveLength(journalLength);
  });
});

describe("rollback: dependencies, trees, secrets", () => {
  test("undoing deps.add lists and runs the compensating install", async () => {
    // Arrange — no dependencies before, so the compensating install stays offline.
    const root = scratchProject({ "package.json": '{\n  "name": "demo",\n  "private": true\n}\n' });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const run = testContext(root);

    // Act
    const preview = await previewRollback(run.ctx, root, applied.operationId);
    const result = await rollbackOperation(run.ctx, root, applied.operationId);

    // Assert
    expect(preview.limits.join("\n")).toContain("bun install --no-save");
    expect(result.status).toBe("rolled-back");
    expect(run.events.some((event) => event.type === "rollback.compensate")).toBe(true);
    expect(snapshot(root)).toEqual(before);
  }, 120_000);

  test("a generated tree patched by later steps is removed as a whole", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "generator.run",
        generator: { package: "fake-gen", range: "1", version: "1.0.0", integrity: null },
        argv: [
          "sh",
          "-c",
          "mkdir -p web/src && echo '<h1>hi</h1>' > web/index.html && echo x > web/src/a.ts",
        ],
        cwd: ".",
        mode: "staged",
        produces: "apps/web",
        stdin: null,
        timeoutMs: 60_000,
        scrubGit: true,
        predictable: false,
        description: "generate apps/web",
        classes: ["generator"],
        reversible: true,
        compensation: "delete apps/web",
      });
      await b.writeFile({
        path: "apps/web/extra.txt",
        content: "patch\n",
        description: "patch apps/web",
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const generatedIndex = readFileSync(join(root, "apps/web/index.html"), "utf8");

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(generatedIndex).toBe("<h1>hi</h1>\n");
    expect(preview.possible).toBe(true);
    expect(preview.steps.map((step) => step.action)).toEqual(["delete", "delete"]);
    expect(snapshot(root)).toEqual(before);
  });

  test("backups never contain a generated secret, yet restore it exactly", async () => {
    // Arrange
    const root = scratchProject({ ".env.local": "EXISTING=1\n" });
    const before = snapshot(root);
    // The second step's backup is taken AFTER the secret exists in the file.
    const plan = await buildPlan(root, async (b) => {
      addSecret(b, ".env.local", "APP_SECRET");
      addCommand(b, "printf 'PUBLIC_URL=http://localhost:3000\\n' >> .env.local; cat .env.local", {
        touches: [".env.local"],
        description: "append PUBLIC_URL and print the file",
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const secret =
      /APP_SECRET=(\S+)/.exec(readFileSync(join(root, ".env.local"), "utf8"))?.[1] ?? "";

    // Act
    const leakAfterApply = anyFileContains(join(root, ".groot"), secret);
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(secret).toHaveLength(43);
    expect(leakAfterApply).toBeNull();
    expect(anyFileContains(join(root, ".groot"), secret)).toBeNull();
    expect(snapshot(root)).toEqual(before);
  });
});

describe("tree simulation", () => {
  test("with no overrides it equals hashTree; overrides model undone file changes", async () => {
    // Arrange
    const root = scratchProject({
      "apps/web/index.html": "<h1/>\n",
      "apps/web/src/a.ts": "a\n",
      "apps/web/src/b.ts": "b\n",
      "apps/web/A.md": "upper\n",
      "apps/web/a.md": "lower\n",
    });
    mkdirSync(join(root, "apps/web/node_modules/x"), { recursive: true });
    writeFileSync(join(root, "apps/web/node_modules/x/i.js"), "ignored\n");
    const original = await hashTree(join(root, "apps/web"));
    writeFileSync(join(root, "apps/web/src/c.ts"), "added later\n");

    // Act
    const plain = await simulatedTreeHash(root, "apps/web", new Map());
    const undone = await simulatedTreeHash(
      root,
      "apps/web",
      new Map([["apps/web/src/c.ts", null]]),
    );

    // Assert
    expect(plain).toBe(await hashTree(join(root, "apps/web")));
    expect(undone).toBe(original);
  });
});
