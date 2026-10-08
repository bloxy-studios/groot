/**
 * Resume trusts neither its stored plan copy nor a lost approval: the copy
 * must be the plan the journal started (same id and fingerprint), and the
 * steps still to run are held to the project policy again — explicit
 * approvals are per run, so a resume needs its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "../contracts/blueprint.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { prettyJson } from "../json.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { applyPlan, resumeOperation } from "./index.ts";
import {
  addCommand,
  buildPlan,
  operationDir,
  refingerprint,
  removeScratchDirs,
  scratchProject,
  testContext,
} from "./test-support.ts";

afterAll(removeScratchDirs);

const FILES_ONLY: Policy = { allow: ["fs.create", "fs.edit"], external: "deny" };

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

/** Apply under `policy` (+ approvals) and stop at the boundary after s01. */
async function interruptedAfterFirstStep(
  root: string,
  plan: OperationPlan,
  policy: Policy,
  approvals: Policy["allow"] = [],
): Promise<string> {
  const run = testContext(root, (event) => {
    if (event.type === "step.done" && event.stepId === "s01") run.controller.abort("SIGINT");
  });
  const error = await expectGrootError(
    applyPlan(run.ctx, { plan, root, policy, approvals, command: "apply" }),
  );
  expect(error.id).toBe("GROOT_E_INTERRUPTED");
  return String(error.details?.operationId);
}

async function writesTwoFiles(root: string): Promise<OperationPlan> {
  return buildPlan(root, async (b) => {
    await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    await b.writeFile({ path: "b.txt", content: "b\n", description: "create b.txt" });
  });
}

/** Swap the stored plan copy's second step for a command (fingerprint recomputed). */
function swapInCommand(root: string, operationId: string, plan: OperationPlan): OperationPlan {
  const pwned = refingerprint({
    ...plan,
    actions: [
      plan.actions[0] as OperationPlan["actions"][number],
      {
        type: "command.run",
        id: "s02",
        argv: ["sh", "-c", "echo pwned > pwned.txt"],
        cwd: ".",
        purpose: "script",
        network: false,
        idempotent: true,
        timeoutMs: 10_000,
        env: {},
        stdin: null,
        touches: [],
        description: "create b.txt",
        classes: ["fs.create"],
        reversible: true,
        compensation: "none",
      },
    ],
  });
  writeFileSync(join(operationDir(root, operationId), "plan.json"), prettyJson(pwned));
  return pwned;
}

describe("resume verifies its plan copy", () => {
  test("a plan copy that is not the plan the journal started is refused", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await writesTwoFiles(root);
    const operationId = await interruptedAfterFirstStep(root, plan, FILES_ONLY);
    swapInCommand(root, operationId, plan);

    // Act
    const error = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId, { policy: FILES_ONLY }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(existsSync(join(root, "pwned.txt"))).toBe(false);
  });

  test("with the journal forged too, the policy still refuses what the plan copy now needs", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await writesTwoFiles(root);
    const operationId = await interruptedAfterFirstStep(root, plan, FILES_ONLY);
    const pwned = swapInCommand(root, operationId, plan);
    const journal = join(operationDir(root, operationId), "journal.jsonl");
    const lines = readFileSync(journal, "utf8").split("\n");
    const started = JSON.parse(lines[0] as string);
    lines[0] = JSON.stringify({ ...started, planFingerprint: pwned.fingerprint });
    writeFileSync(journal, lines.join("\n"));
    writeFileSync(
      join(root, "groot.json"),
      `${JSON.stringify(blueprintFixture({ policy: FILES_ONLY }), null, 2)}\n`,
    );

    // Act
    const explicit = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId, { policy: FILES_ONLY }),
    );
    const fromBlueprint = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId),
    );

    // Assert
    for (const error of [explicit, fromBlueprint]) {
      expect(error.id).toBe("GROOT_E_POLICY_DENIED");
      expect(error.details?.denied).toEqual(["command"]);
    }
    expect(existsSync(join(root, "pwned.txt"))).toBe(false);
  });
});

describe("resume re-checks the policy for the steps it will run", () => {
  test("an approval given to apply does not carry over; the resume's own approval does", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      addCommand(b, "echo ran > ran.txt", { idempotent: true });
    });
    const operationId = await interruptedAfterFirstStep(root, plan, FILES_ONLY, ["command"]);

    // Act
    const denied = await expectGrootError(
      resumeOperation(testContext(root).ctx, root, operationId, { policy: FILES_ONLY }),
    );
    const approved = await resumeOperation(testContext(root).ctx, root, operationId, {
      policy: FILES_ONLY,
      approvals: ["command"],
    });

    // Assert
    expect(denied.id).toBe("GROOT_E_POLICY_DENIED");
    expect(denied.details?.denied).toEqual(["command"]);
    expect(approved.status).toBe("completed");
    expect(readFileSync(join(root, "ran.txt"), "utf8")).toBe("ran\n");
  });

  test("completed steps need no approval again", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "echo ran > ran.txt", { idempotent: true });
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    });
    const operationId = await interruptedAfterFirstStep(root, plan, FILES_ONLY, ["command"]);

    // Act
    const result = await resumeOperation(testContext(root).ctx, root, operationId, {
      policy: FILES_ONLY,
    });

    // Assert
    expect(result.status).toBe("completed");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });
});
