/**
 * Rollback: byte-identical restoration (content and mode), deletion of
 * created files and directories (also of steps with nothing else to undo),
 * conflicts for later human edits and for a `.git` inside a tree it would
 * clear (refused with nothing changed), generated trees patched by later
 * steps, generated links (removed, never followed), secret concealment in
 * backups, the compensating install, and idempotence.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GrootV2Error } from "../errors.ts";
import { hashTree } from "../fs/hash.ts";
import {
  applyPlan,
  previewRollback,
  registerInternalHandler,
  resumeOperation,
  rollbackOperation,
} from "./index.ts";
import {
  addCommand,
  addDeps,
  addGenerator,
  addSecret,
  anyFileContains,
  buildPlan,
  crashAfterEffect,
  journalRecords,
  MULTI_STEP_FILES,
  operationDir,
  permissive,
  removeScratchDirs,
  scratchDir,
  scratchProject,
  setMode,
  snapshot,
  testContext,
} from "./test-support.ts";
import { simulatedTreeHash } from "./tree-sim.ts";

afterAll(removeScratchDirs);

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

  test("a preview takes no lock and never repairs the journal", async () => {
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
    const journal = join(operationDir(root, applied.operationId), "journal.jsonl");
    appendFileSync(journal, '{"seq":99,"type":"rollback.st'); // as if a writer were mid-append
    const bytes = readFileSync(journal, "utf8");

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(preview.possible).toBe(true);
    expect(readFileSync(journal, "utf8")).toBe(bytes);
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

  test("a generated tree that now holds a .git is a conflict; nothing is deleted", async () => {
    // Arrange — tree hashes ignore .git, so only a scan finds the repository.
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p web && echo g > web/index.html",
        produces: "web",
        mode: "staged",
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    mkdirSync(join(root, "web/.git"));
    writeFileSync(join(root, "web/.git/HEAD"), "ref: refs/heads/main\n");
    const meanwhile = snapshot(root);

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);
    const error = await expectGrootError(
      rollbackOperation(testContext(root).ctx, root, applied.operationId),
    );

    // Assert
    expect(preview.possible).toBe(false);
    expect(preview.conflicts).toEqual(["web/.git"]);
    expect(error.id).toBe("GROOT_E_ROLLBACK_CONFLICT");
    expect(readFileSync(join(root, "web/.git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(snapshot(root)).toEqual(meanwhile);
  });

  test("a generated link pointing outside the project is removed; its target is untouched", async () => {
    // Arrange — a root generator whose output includes a symlink to a directory elsewhere.
    const outside = scratchDir("groot-link-target-");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    const root = scratchProject();
    const name = basename(root);
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: `mkdir -p ${name} && echo g > ${name}/index.html && ln -s '${outside}' ${name}/shared`,
        produces: ".",
        mode: "staged",
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Act
    const result = await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(result.status).toBe("rolled-back");
    expect(readdirSync(root).filter((entry) => entry !== ".groot")).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
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

describe("rollback: directories and files a step created without reporting them", () => {
  async function deepWrite(root: string) {
    return buildPlan(root, async (b) => {
      await b.writeFile({
        path: "src/deep/new.ts",
        content: "export {};\n",
        description: "create",
      });
    });
  }

  test("an interrupted write's rollback also removes the parent directories it created", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const applied = await applyPlan(testContext(root).ctx, {
      plan: await deepWrite(root),
      root,
      policy: permissive,
      command: "apply",
    });
    crashAfterEffect(root, applied.operationId, "s01");

    // Act
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(snapshot(root)).toEqual(before);
  });

  test("a step reconciled by resume journals the directories it created", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const applied = await applyPlan(testContext(root).ctx, {
      plan: await deepWrite(root),
      root,
      policy: permissive,
      command: "apply",
    });
    crashAfterEffect(root, applied.operationId, "s01");
    await resumeOperation(testContext(root).ctx, root, applied.operationId);

    // Act
    const done = journalRecords(root, applied.operationId).find(
      (record) => record.type === "step.done",
    );
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(done?.type === "step.done" ? done.created : []).toEqual([
      "src",
      "src/deep",
      "src/deep/new.ts",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  test("a command's touched file and the directories it made for it are removed", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "mkdir -p out/deep && echo x > out/deep/file.txt", {
        touches: ["out/deep/file.txt"],
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Act
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(snapshot(root)).toEqual(before);
  });

  test("a failed command's directories go even though its touched file never appeared", async () => {
    // Arrange — nothing tracked changed, so the step's undo is "nothing-to-do".
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "mkdir -p out/deep && exit 3", { touches: ["out/deep/file.txt"] });
    });
    const failed = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );
    const operationId = String(failed.details?.operationId);

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, operationId);
    const result = await rollbackOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(failed.id).toBe("GROOT_E_COMMAND_FAILED");
    expect(preview.steps.map((step) => step.action)).toEqual(["nothing-to-do"]);
    expect(result.status).toBe("rolled-back");
    expect(snapshot(root)).toEqual(before);
  });

  test("files an internal handler created beyond its touches are rolled back", async () => {
    // Arrange
    registerInternalHandler("test.create-files", async ({ root }) => {
      mkdirSync(join(root, "gen"), { recursive: true });
      writeFileSync(join(root, "gen/out.txt"), "generated\n");
      return { created: ["gen", "gen/out.txt"] };
    });
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "internal",
        handler: "test.create-files",
        args: {},
        touches: [],
        description: "run a vetted stage",
        classes: ["fs.create"],
        reversible: true,
        compensation: "remove what it created",
      });
    });
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Act
    const preview = await previewRollback(testContext(root).ctx, root, applied.operationId);
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(preview.steps[0]?.paths).toEqual(["gen/out.txt"]);
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
