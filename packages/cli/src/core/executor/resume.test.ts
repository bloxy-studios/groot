/**
 * resumeOperation: reconciliation of an in-flight step against its
 * postcondition, the non-idempotent command gate, per-step staleness for
 * pending steps, torn journal tails, and resumability rules.
 *
 * A crash "after the effect, before completion" is simulated in-process by
 * truncating the journal right after the step's intent record (the effect is
 * on disk, step.done never made it). Real SIGKILL crashes are covered by the
 * process-level tests in commands/recovery-cli.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { applyPlan, readOperation, resumeOperation } from "./index.ts";
import {
  addCommand,
  addDeps,
  buildPlan,
  crashAfterEffect,
  journalRecords,
  operationDir,
  permissive,
  removeScratchDirs,
  scratchProject,
  stateFile,
  testContext,
} from "./test-support.ts";

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

async function applied(root: string, plan: OperationPlan): Promise<string> {
  const result = await applyPlan(testContext(root).ctx, {
    plan,
    root,
    policy: permissive,
    command: "apply",
  });
  return result.operationId;
}

function doneOutcome(root: string, operationId: string, stepId: string): string | undefined {
  const done = journalRecords(root, operationId).filter(
    (record) => record.type === "step.done" && record.stepId === stepId,
  );
  const last = done.at(-1);
  return last?.type === "step.done" ? last.outcome : undefined;
}

const README = "# Demo\n";

async function writeThenEdit(root: string): Promise<OperationPlan> {
  return buildPlan(root, async (b) => {
    await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    await b.editFile({
      path: "README.md",
      edit: { kind: "lines", lines: ["Managed."], header: null },
      description: "edit README.md",
      owns: [],
      createIfMissing: false,
    });
  });
}

describe("resume: in-flight file steps", () => {
  test("an effect that landed is reconciled, not repeated", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const operationId = await applied(root, await writeThenEdit(root));
    crashAfterEffect(root, operationId, "s02");

    // Act
    const status = (await readOperation(root, operationId)).status;
    const result = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(status).toBe("interrupted");
    expect(result.status).toBe("completed");
    expect(doneOutcome(root, operationId, "s02")).toBe("reconciled");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Demo\n\nManaged.\n");
  });

  test("an effect that never landed is re-run", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const operationId = await applied(root, await writeThenEdit(root));
    crashAfterEffect(root, operationId, "s02");
    writeFileSync(join(root, "README.md"), README); // the write never happened

    // Act
    const result = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(result.status).toBe("completed");
    expect(doneOutcome(root, operationId, "s02")).toBe("applied");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Demo\n\nManaged.\n");
  });

  test("a file changed by someone else meanwhile is a conflict naming it; nothing is journaled", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const operationId = await applied(root, await writeThenEdit(root));
    crashAfterEffect(root, operationId, "s02");
    writeFileSync(join(root, "README.md"), "# Someone else\n");
    const journalBefore = readFileSync(
      join(operationDir(root, operationId), "journal.jsonl"),
      "utf8",
    );

    // Act
    const error = await expectGrootError(resumeOperation(testContext(root).ctx, root, operationId));

    // Assert
    expect(error.id).toBe("GROOT_E_CONFLICT");
    expect(error.details?.paths).toEqual(["README.md"]);
    expect(readFileSync(join(operationDir(root, operationId), "journal.jsonl"), "utf8")).toBe(
      journalBefore,
    );
  });

  test("deferred edits and dependency merges reconcile from their backups", async () => {
    // Arrange
    const root = scratchProject({ "package.json": '{\n  "name": "x"\n}\n' });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.editFile({
        path: "a.txt",
        edit: { kind: "lines", lines: ["more"], header: null },
        description: "extend a.txt",
        owns: [],
        createIfMissing: false,
        deferred: true,
      });
      await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
    });
    const operationId = await applied(root, plan);
    crashAfterEffect(root, operationId, "s03");

    // Act
    const result = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(result.status).toBe("completed");
    expect(doneOutcome(root, operationId, "s03")).toBe("reconciled");
  });
});

describe("resume: commands", () => {
  test("a non-idempotent command in flight blocks until --skip-step", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "echo ran >> log.txt", { touches: ["log.txt"] });
    });
    const operationId = await applied(root, plan);
    crashAfterEffect(root, operationId, "s01");

    // Act
    const blocked = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId),
    );
    const skipped = await resumeOperation(testContext(root).ctx, root, operationId, {
      skipStep: "s01",
    });

    // Assert
    expect(blocked.id).toBe("GROOT_E_BLOCKED");
    expect(blocked.toInfo().exitCode).toBe(7);
    expect(blocked.details?.stepId).toBe("s01");
    expect(skipped.status).toBe("completed");
    expect(doneOutcome(root, operationId, "s01")).toBe("already-applied");
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\n");
  });

  test("--retry-step re-runs a non-idempotent command on request", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "echo ran >> log.txt", { touches: ["log.txt"] });
    });
    const operationId = await applied(root, plan);
    crashAfterEffect(root, operationId, "s01");

    // Act
    const result = await resumeOperation(testContext(root).ctx, root, operationId, {
      retryStep: "s01",
    });

    // Assert
    expect(result.status).toBe("completed");
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\nran\n");
  });

  test("an idempotent command in flight is simply re-run", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "grep -qx ran log.txt 2>/dev/null || echo ran >> log.txt", {
        touches: ["log.txt"],
        idempotent: true,
      });
    });
    const operationId = await applied(root, plan);
    crashAfterEffect(root, operationId, "s01");

    // Act
    const result = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(result.status).toBe("completed");
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\n");
  });

  test("step options must name the interrupted step", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "echo ran >> log.txt", { touches: ["log.txt"] });
    });
    const operationId = await applied(root, plan);
    crashAfterEffect(root, operationId, "s01");

    // Act
    const error = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId, { retryStep: "s09" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_USAGE");
    expect(error.message).toContain("s01");
  });
});

describe("resume: pending steps and journal integrity", () => {
  test("a human edit during the interruption is a narrow stale plan; completed steps stay", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const plan = await writeThenEdit(root);
    const run = testContext(root, (event) => {
      if (event.type === "step.done" && event.stepId === "s01") run.controller.abort("SIGINT");
    });
    const interrupted = await expectGrootError(
      applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
    );
    const operationId = String(interrupted.details?.operationId);
    writeFileSync(join(root, "README.md"), "# Edited during the interruption\n");

    // Act
    const stale = await expectGrootError(resumeOperation(testContext(root).ctx, root, operationId));
    const conflicted = stateFile(root, operationId);
    writeFileSync(join(root, "README.md"), README);
    const resumed = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(stale.id).toBe("GROOT_E_STALE_PLAN");
    expect(
      ((stale.details?.findings ?? []) as { path: string }[]).map((finding) => finding.path),
    ).toEqual(["README.md"]);
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.steps[0]?.status).toBe("done");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(resumed.status).toBe("completed");
  });

  test("a torn final journal line is ignored and repaired before appending", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const plan = await writeThenEdit(root);
    const run = testContext(root, (event) => {
      if (event.type === "step.done" && event.stepId === "s01") run.controller.abort("SIGINT");
    });
    const interrupted = await expectGrootError(
      applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
    );
    const operationId = String(interrupted.details?.operationId);
    appendFileSync(
      join(operationDir(root, operationId), "journal.jsonl"),
      '{"seq":99,"type":"step.do',
    );

    // Act
    const before = await readOperation(root, operationId);
    const result = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(before.status).toBe("interrupted");
    expect(result.status).toBe("completed");
    expect(journalRecords(root, operationId).at(-1)?.type).toBe("operation.completed");
  });

  test("a completed operation is not resumable", async () => {
    // Arrange
    const root = scratchProject({ "README.md": README });
    const operationId = await applied(root, await writeThenEdit(root));

    // Act
    const error = await expectGrootError(resumeOperation(testContext(root).ctx, root, operationId));

    // Assert
    expect(error.id).toBe("GROOT_E_NOT_RESUMABLE");
  });

  test("an unknown operation id is not found", async () => {
    // Arrange
    const root = scratchProject();

    // Act
    const error = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, "op_00000000000000000000aa"),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_NOT_FOUND");
  });
});
