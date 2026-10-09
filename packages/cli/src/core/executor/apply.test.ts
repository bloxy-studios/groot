/**
 * applyPlan: multi-step execution with contract-valid journal/state,
 * idempotent re-apply, narrow stale-plan detection, policy, plan-document
 * validation, failure recording, and boundary interruption.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { canonicalJson } from "../json.ts";
import {
  applyPlan,
  checkPlanFreshness,
  findProjectRoot,
  loadPlanFile,
  loadSavedPlan,
  resumeOperation,
  savePlan,
} from "./index.ts";
import { requiredClasses } from "./policy.ts";
import {
  addCommand,
  addSecret,
  anyFileContains,
  buildPlan,
  journalRecords,
  MULTI_STEP_FILES,
  multiStepPlan,
  operationDir,
  operationIds,
  permissive,
  removeScratchDirs,
  scratchProject,
  snapshot,
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

/** A hand-edited plan declaring no classes at all (fingerprint recomputed, so it still loads). */
function withoutDeclaredClasses(plan: OperationPlan): OperationPlan {
  const actions = plan.actions.map((action) => ({ ...action, classes: [] }));
  const fingerprint = sha256Of(
    canonicalJson({ intent: plan.intent, actions, preconditions: plan.preconditions }),
  );
  return { ...plan, actions, requiredClasses: [], fingerprint };
}

describe("applyPlan: multi-step execution", () => {
  test("runs write, edits, deps, command, delete, and secret with contract-valid journal and state", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);
    const { ctx, events } = testContext(root);

    // Act
    const result = await applyPlan(ctx, { plan, root, policy: permissive, command: "apply" });

    // Assert
    expect(result.status).toBe("completed");
    expect(result.alreadyApplied).toBe(false);
    expect(result.steps.map((step) => step.status)).toEqual(Array(7).fill("done"));
    expect(readFileSync(join(root, "src/greeting.ts"), "utf8")).toBe(
      'export const greeting = "hi";\n\nexport const extra = 1;\n',
    );
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Demo\n\nManaged by groot.\n");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
      '{\n    "name": "demo",\n    "version": "1.0.0",\n    "dependencies": {\n        "left-pad": "1.3.0",\n        "zod": "4.0.0"\n    },\n    "devDependencies": {\n        "typescript": "5.9.2"\n    }\n}\n',
    );
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\n");
    expect(existsSync(join(root, "obsolete.txt"))).toBe(false);
    const env = readFileSync(join(root, ".env.local"), "utf8");
    expect(env).toMatch(/^APP_SECRET=[A-Za-z0-9_-]{43}\n$/);
    expect(statSync(join(root, ".env.local")).mode & 0o777).toBe(0o600);

    const records = journalRecords(root, result.operationId); // each line validated by the helper
    expect(records[0]?.type).toBe("operation.started");
    expect(records.at(-1)?.type).toBe("operation.completed");
    expect(records.filter((record) => record.type === "step.intent")).toHaveLength(7);
    expect(records.filter((record) => record.type === "step.done")).toHaveLength(7);
    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index));
    const state = stateFile(root, result.operationId); // validated by the helper
    expect(state.status).toBe("completed");
    expect(state.resumable).toBe(false);

    const secret = env.slice("APP_SECRET=".length).trim();
    expect(anyFileContains(join(root, ".groot"), secret)).toBeNull();
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("re-applying a completed plan returns alreadyApplied with no new effects", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);
    const first = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const journalBefore = readFileSync(
      join(operationDir(root, first.operationId), "journal.jsonl"),
      "utf8",
    );
    const treeBefore = snapshot(root);

    // Act
    const again = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Assert
    expect(again.alreadyApplied).toBe(true);
    expect(again.operationId).toBe(first.operationId);
    expect(operationIds(root)).toEqual([first.operationId]);
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\n");
    expect(snapshot(root)).toEqual(treeBefore);
    expect(readFileSync(join(operationDir(root, first.operationId), "journal.jsonl"), "utf8")).toBe(
      journalBefore,
    );
  });
});

describe("applyPlan: freshness", () => {
  test("a touched file edited after planning makes the plan stale naming exactly that path", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);
    writeFileSync(join(root, "README.md"), "# Demo (edited by a human)\n");
    const before = snapshot(root);

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(error.toInfo().exitCode).toBe(6);
    const findings = (error.details?.findings ?? []) as { path: string; reason: string }[];
    expect(findings.map((finding) => finding.path)).toEqual(["README.md"]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".groot"))).toBe(false);
    expect(await checkPlanFreshness(root, plan)).toHaveLength(1);
  });

  test("an unrelated file edited after planning does not matter", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);
    writeFileSync(join(root, "unrelated.txt"), "changed\n");

    // Act
    const result = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });

    // Assert
    expect(result.status).toBe("completed");
  });
});

describe("applyPlan: policy", () => {
  test("denies classes the policy does not allow, listing them, and writes nothing", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);
    const policy = { allow: ["fs.create", "fs.edit"] as const, external: "deny" as const };

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, {
        plan,
        root,
        policy: { ...policy, allow: [...policy.allow] },
        command: "apply",
      }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_POLICY_DENIED");
    expect(error.toInfo().exitCode).toBe(7);
    expect(error.details?.denied).toEqual(["command", "deps.change", "fs.delete"]);
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("explicit approvals extend the policy for one run", async () => {
    // Arrange
    const root = scratchProject(MULTI_STEP_FILES);
    const plan = await multiStepPlan(root);

    // Act
    const result = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: { allow: ["fs.create", "fs.edit"], external: "deny" },
      approvals: ["command", "deps.change", "fs.delete"],
      command: "apply",
    });

    // Assert
    expect(result.status).toBe("completed");
  });

  test("a plan cannot under-declare: action types imply their classes", async () => {
    // Arrange
    const root = scratchProject();
    const forged = withoutDeclaredClasses(
      await buildPlan(root, async (b) => {
        addCommand(b, "true");
      }),
    );

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, {
        plan: forged,
        root,
        policy: { allow: ["fs.create"], external: "deny" },
        command: "apply",
      }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_POLICY_DENIED");
    expect(error.details?.denied).toEqual(["command"]);
  });

  test("file writes, edits, and secrets that declare no classes are still held to the policy", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n", "owned.txt": "v1\n" });
    const forged = withoutDeclaredClasses(
      await buildPlan(root, async (b) => {
        await b.writeFile({ path: "new.txt", content: "new\n", description: "create new.txt" });
        await b.writeFile({
          path: "owned.txt",
          content: "v2\n",
          description: "replace owned.txt",
          replaceSha: sha256Of("v1\n"),
        });
        await b.editFile({
          path: "README.md",
          edit: { kind: "lines", lines: ["More."], header: null },
          description: "extend README.md",
          owns: [],
          createIfMissing: false,
        });
        addSecret(b, ".env.local", "APP_SECRET");
      }),
    );

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, {
        plan: forged,
        root,
        policy: { allow: ["command"], external: "deny" },
        command: "apply",
      }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_POLICY_DENIED");
    expect(error.details?.denied).toEqual(["fs.create", "fs.edit"]);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("a file step's intrinsic class follows its expectation: creating vs replacing", async () => {
    // Arrange
    const root = scratchProject({ "owned.txt": "v1\n" });

    // Act
    const create = withoutDeclaredClasses(
      await buildPlan(root, async (b) => {
        await b.writeFile({ path: "new.txt", content: "new\n", description: "create new.txt" });
        await b.editFile({
          path: "notes.md",
          edit: { kind: "lines", lines: ["Notes."], header: null },
          description: "create notes.md",
          owns: [],
          createIfMissing: true,
        });
      }),
    );
    const replace = withoutDeclaredClasses(
      await buildPlan(root, async (b) => {
        await b.writeFile({
          path: "owned.txt",
          content: "v2\n",
          description: "replace owned.txt",
          replaceSha: sha256Of("v1\n"),
        });
      }),
    );

    // Assert
    expect(requiredClasses(create)).toEqual(["fs.create"]);
    expect(requiredClasses(replace)).toEqual(["fs.edit"]);
  });

  test("external effects need policy 'ask' plus an explicit approval, then report no adapter", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "external",
        provider: "example",
        effect: "create a database",
        idempotencyKey: "db-1",
        cost: "free",
        description: "create a hosted database",
        classes: ["external", "network"],
        reversible: false,
        compensation: "delete the database in the provider console",
      });
    });

    // Act
    const denied = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );
    const blocked = await expectGrootError(
      applyPlan(testContext(root).ctx, {
        plan,
        root,
        policy: permissive,
        approvals: ["external"],
        command: "apply",
      }),
    );

    // Assert
    expect(denied.id).toBe("GROOT_E_POLICY_DENIED");
    expect(denied.details?.denied).toEqual(["external"]);
    expect(blocked.id).toBe("GROOT_E_BLOCKED");
    expect(blocked.message).toContain("no provider adapters");
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });
});

describe("plan documents", () => {
  test("loadPlanFile reports zod issue paths for an invalid document", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "true");
    });
    const broken = JSON.parse(JSON.stringify(plan));
    broken.actions[0].argv = [];
    const file = join(root, "plan.json");
    writeFileSync(file, JSON.stringify(broken));

    // Act
    const error = await expectGrootError(loadPlanFile(file));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    const issues = (error.details?.issues ?? []) as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain("actions.0.argv");
  });

  test("a document edited after planning fails the fingerprint check", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "true");
    });
    const edited = JSON.parse(JSON.stringify(plan));
    edited.actions[0].argv = ["sh", "-c", "echo sneaky"];
    const file = join(root, "plan.json");
    writeFileSync(file, JSON.stringify(edited));

    // Act
    const error = await expectGrootError(loadPlanFile(file));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(((error.details?.issues ?? []) as { path: string }[])[0]?.path).toBe("fingerprint");
  });

  test("savePlan stores under .groot/plans and loads back by id", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "true");
    });

    // Act
    const path = await savePlan(root, plan);
    const loaded = await loadSavedPlan(root, plan.planId);

    // Assert
    expect(path).toBe(join(root, ".groot", "plans", `${plan.planId}.json`));
    expect(loaded).toEqual(plan);
    expect(findProjectRoot(join(root, ".groot", "plans"))).toBe(root);
  });

  test("a plan made for another root is refused", async () => {
    // Arrange
    const planned = scratchProject();
    const other = scratchProject();
    const plan = await buildPlan(planned, async (b) => {
      addCommand(b, "true");
    });

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(other).ctx, {
        plan,
        root: other,
        policy: permissive,
        command: "apply",
      }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_USAGE");
    expect(error.message).toContain(planned);
  });
});

describe("applyPlan: failures and interruption", () => {
  test("a failing command records step.failed and leaves the operation resumable", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      addCommand(b, "echo boom >&2; exit 3");
    });

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_COMMAND_FAILED");
    expect(error.message).toContain("boom");
    const operationId = String(error.details?.operationId);
    const state = stateFile(root, operationId);
    expect(state.status).toBe("failed");
    expect(state.resumable).toBe(true);
    expect(journalRecords(root, operationId).map((record) => record.type)).toEqual([
      "operation.started",
      "step.intent",
      "step.failed",
      "operation.failed",
    ]);
    expect(readFileSync(join(operationDir(root, operationId), "logs/s01.log"), "utf8")).toContain(
      "boom",
    );
  });

  test("an abort between steps stops at the checkpoint; resume finishes the rest", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.writeFile({ path: "b.txt", content: "b\n", description: "create b.txt" });
    });
    const run = testContext(root, (event) => {
      if (event.type === "step.done" && event.stepId === "s01") run.controller.abort("SIGINT");
    });

    // Act
    const error = await expectGrootError(
      applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
    );
    const operationId = String(error.details?.operationId);
    const interrupted = stateFile(root, operationId);
    const resumed = await resumeOperation(testContext(root).ctx, root, operationId);

    // Assert
    expect(error.id).toBe("GROOT_E_INTERRUPTED");
    expect(error.toInfo().exitCode).toBe(130);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.steps.map((step) => step.status)).toEqual(["done", "pending"]);
    expect(resumed.status).toBe("completed");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\n");
  });
});
