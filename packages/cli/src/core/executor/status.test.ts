/**
 * Operation status as readers see it: an operation whose writer is alive is
 * "running" and NOT resumable (resuming it would only meet GROOT_E_LOCKED);
 * once its writer is gone the same journal reads as interrupted and resumable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, listOperations, readOperation } from "./index.ts";
import {
  addCommand,
  buildPlan,
  crashAfterEffect,
  journalRecords,
  operationIds,
  permissive,
  removeScratchDirs,
  scratchDir,
  scratchProject,
  stateFile,
  testContext,
  waitFor,
} from "./test-support.ts";

afterAll(removeScratchDirs);

describe("resumability", () => {
  test("a live running operation is not resumable; the same journal without a writer is", async () => {
    // Arrange — a command that waits for a gate file outside the project.
    const root = scratchProject();
    const gate = join(scratchDir("groot-gate-"), "open");
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, `while [ ! -f '${gate}' ]; do sleep 0.05; done; echo ok > done.txt`, {
        idempotent: true,
        timeoutMs: 60_000,
        touches: ["done.txt"],
      });
    });
    const running = applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    await waitFor(
      () =>
        operationIds(root).length === 1 &&
        journalRecords(root, String(operationIds(root)[0])).some(
          (record) => record.type === "step.intent",
        ),
      30_000,
      "the command step to start",
    );
    const operationId = String(operationIds(root)[0]);

    // Act
    const live = await readOperation(root, operationId);
    const listed = await listOperations(root);
    const snapshotWhileRunning = stateFile(root, operationId);
    writeFileSync(gate, "");
    const finished = await running;
    crashAfterEffect(root, operationId, "s01");
    const crashed = await readOperation(root, operationId);

    // Assert
    expect(live.status).toBe("running");
    expect(live.resumable).toBe(false);
    expect(listed[0]?.resumable).toBe(false);
    expect(snapshotWhileRunning.resumable).toBe(false);
    expect(finished.status).toBe("completed");
    expect(existsSync(join(root, "done.txt"))).toBe(true);
    expect(crashed.status).toBe("interrupted");
    expect(crashed.resumable).toBe(true);
  }, 60_000);
});
