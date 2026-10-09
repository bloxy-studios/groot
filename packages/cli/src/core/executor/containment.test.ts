/**
 * Executor state stays inside the project: every operation path goes through
 * core/state.ts, so a symlinked `.groot` (e.g. committed in a cloned repo) is
 * refused by apply, resume, rollback, and status alike — and the files of an
 * operation directory (plan copy, journal, backups, logs) are refused when a
 * symlink stands in for them, before anything is written through it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import {
  applyPlan,
  listOperations,
  previewRollback,
  readOperation,
  resumeOperation,
  rollbackOperation,
} from "./index.ts";
import {
  addCommand,
  allFiles,
  buildPlan,
  operationDir,
  permissive,
  removeScratchDirs,
  scratchDir,
  scratchProject,
  testContext,
} from "./test-support.ts";

afterAll(removeScratchDirs);

const API_KEY = "sk-live-0123456789abcdef0123";
const FILES = { ".env": `API_KEY=${API_KEY}\n`, "README.md": "# Demo\n" };

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

/** s01 write · s02 command touching .env (its intent backs .env up). */
async function twoStepPlan(root: string): Promise<OperationPlan> {
  return buildPlan(root, async (b) => {
    await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    addCommand(b, "echo '# touched' >> .env", { touches: [".env"], idempotent: true });
  });
}

/** Apply `plan` and stop at the boundary after s01: an interrupted, resumable operation. */
async function interruptedAfterFirstStep(root: string, plan: OperationPlan): Promise<string> {
  const run = testContext(root, (event) => {
    if (event.type === "step.done" && event.stepId === "s01") run.controller.abort("SIGINT");
  });
  const error = await expectGrootError(
    applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
  );
  expect(error.id).toBe("GROOT_E_INTERRUPTED");
  return String(error.details?.operationId);
}

describe("a symlinked .groot is refused everywhere", () => {
  test("apply refuses before writing anything inside or outside the project", async () => {
    // Arrange
    const root = scratchProject(FILES);
    const outside = scratchDir("groot-outside-");
    symlinkSync(outside, join(root, ".groot"));
    const plan = await twoStepPlan(root);

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  test("status, resume, and rollback refuse an operation whose .groot became a symlink", async () => {
    // Arrange
    const root = scratchProject(FILES);
    const operationId = await interruptedAfterFirstStep(root, await twoStepPlan(root));
    const outside = scratchDir("groot-outside-");
    renameSync(join(root, ".groot"), join(outside, "state"));
    symlinkSync(join(outside, "state"), join(root, ".groot"));
    const filesBefore = allFiles(outside).length;

    // Act
    const listed = await expectGrootError(listOperations(root));
    const shown = await expectGrootError(readOperation(root, operationId));
    const resumed = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId),
    );
    const previewed = await expectGrootError(
      previewRollback(testContext(root).ctx, root, operationId),
    );
    const rolledBack = await expectGrootError(
      rollbackOperation(testContext(root).ctx, root, operationId),
    );

    // Assert
    for (const error of [listed, shown, resumed, previewed, rolledBack]) {
      expect(error.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    }
    expect(allFiles(outside)).toHaveLength(filesBefore);
  });
});

describe("symlinks inside an operation directory are refused", () => {
  for (const entry of ["backups", "logs", "journal.jsonl", "plan.json"]) {
    test(`resume refuses a symlinked ${entry} and writes nothing through it`, async () => {
      // Arrange
      const root = scratchProject(FILES);
      const operationId = await interruptedAfterFirstStep(root, await twoStepPlan(root));
      const dir = operationDir(root, operationId);
      const outside = scratchDir("groot-outside-");
      cpSync(join(dir, entry), join(outside, entry), { recursive: true });
      rmSync(join(dir, entry), { recursive: true, force: true });
      symlinkSync(join(outside, entry), join(dir, entry));
      const filesBefore = allFiles(outside).length;

      // Act
      const error = await expectGrootError(
        resumeOperation(testContext(root).ctx, root, operationId),
      );

      // Assert
      expect(error.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
      expect(allFiles(outside)).toHaveLength(filesBefore);
    });
  }
});
