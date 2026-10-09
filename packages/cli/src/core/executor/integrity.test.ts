/**
 * Plan integrity against forged documents: a `produced` expectation must name
 * an earlier step that produces exactly that path (and holds that step's
 * recorded result, directories included), Groot's own `.groot/` state and
 * `.git/` are never action targets (also not through a symlink, nor nested
 * in a tree a recursive delete would remove), and the up-front freshness
 * check covers every action's own expectation so a stale plan writes
 * nothing even when its preconditions under-declare.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan, PathExpectation, PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import type { ActionDraft } from "../planner/builder.ts";
import { ensureStateDir } from "../state.ts";
import { checkExpectation } from "./freshness.ts";
import { applyPlan, checkPlanFreshness, validatePlanDocument } from "./index.ts";
import {
  addCommand,
  addGenerator,
  buildPlan,
  journalRecords,
  permissive,
  refingerprint,
  removeScratchDirs,
  scratchProject,
  snapshot,
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

function issuePaths(error: GrootV2Error): string[] {
  return ((error.details?.issues ?? []) as { path: string }[]).map((issue) => issue.path);
}

/** Replace action `index` (fingerprint recomputed — only integrity rules can catch the forgery). */
function forge(
  plan: OperationPlan,
  index: number,
  change: (action: PlannedAction) => PlannedAction,
): OperationPlan {
  const actions = plan.actions.map((action, at) => (at === index ? change(action) : action));
  return refingerprint({ ...plan, actions });
}

function apply(root: string, plan: OperationPlan) {
  return applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" });
}

/** A recursive delete — allowed for directory trees an earlier step of the plan produced. */
function deleteTree(path: string, expect: PathExpectation): ActionDraft {
  return {
    type: "file.delete",
    path,
    expect,
    recursive: true,
    description: `delete ${path}`,
    classes: ["fs.delete"],
    reversible: true,
    compensation: `restore ${path} from backup`,
  };
}

describe("produced expectations name a real earlier producer", () => {
  test("a write claiming a non-existent producer is refused before it can overwrite a human file", async () => {
    // Arrange
    const root = scratchProject({ "notes.txt": "human notes\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "other.txt", content: "groot\n", description: "create other.txt" });
    });
    const forged = forge(plan, 0, (action) => ({
      ...action,
      path: "notes.txt",
      expect: { state: "produced", byStep: "s99" },
    }));

    // Act
    const error = await expectGrootError(apply(root, forged));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(error)).toEqual(["actions.0.expect.byStep"]);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("human notes\n");
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("a recursive delete of a human directory claiming a non-existent producer is refused", async () => {
    // Arrange
    const root = scratchProject({ "src/index.ts": "export {};\n", "src/lib/a.ts": "a\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      b.add(deleteTree("src", { state: "produced", byStep: "s99" }));
    });

    // Act
    const error = await expectGrootError(apply(root, refingerprint(plan)));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(error)).toEqual(["actions.0.expect.byStep"]);
    expect(snapshot(root)).toEqual(before);
  });

  for (const target of [".git", ".groot"]) {
    test(`a producer that does not produce exactly that path is refused (${target} behind an unrelated step)`, async () => {
      // Arrange
      const root = scratchProject({ [`${target}/HEAD`]: "keep\n", "README.md": "# x\n" });
      const plan = await buildPlan(root, async (b) => {
        await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
        b.add(deleteTree("src", { state: "produced", byStep: "s01" }));
      });
      const forged = forge(plan, 1, (action) => ({ ...action, path: target }));

      // Act
      const error = await expectGrootError(apply(root, forged));

      // Assert
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(issuePaths(error)).toContain("actions.1.expect.byStep");
      expect(issuePaths(error)).toContain("actions.1.path");
      expect(readFileSync(join(root, `${target}/HEAD`), "utf8")).toBe("keep\n");
      expect(existsSync(join(root, "a.txt"))).toBe(false);
    });
  }

  test("a later step cannot name itself or a later step as its producer", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.writeFile({ path: "b.txt", content: "b\n", description: "create b.txt" });
    });
    const forged = forge(plan, 0, (action) => ({
      ...action,
      path: "b.txt",
      expect: { state: "produced", byStep: "s02" },
    }));

    // Act
    const error = await expectGrootError(apply(root, forged));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(error)).toEqual(["actions.0.expect.byStep"]);
  });

  test("a precondition cannot expect a produced path (nothing has run when it is checked)", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    });
    const forged = refingerprint({
      ...plan,
      preconditions: [
        ...plan.preconditions,
        { type: "path", path: "a.txt", expect: { state: "produced", byStep: "s01" }, dirty: false },
      ],
    });

    // Act
    let error: unknown;
    try {
      validatePlanDocument(forged);
    } catch (caught) {
      error = caught;
    }

    // Assert
    expect(error).toBeInstanceOf(GrootV2Error);
    expect(issuePaths(error as GrootV2Error)).toEqual(["preconditions.1.expect"]);
  });

  test("a builder-made plan with produced expectations still validates", async () => {
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
      addGenerator(b, {
        script: "mkdir -p gen && echo g > gen/x",
        produces: "gen",
        mode: "staged",
      });
      b.add(deleteTree("gen", await b.expectationFor("gen")));
    });

    // Act
    const validated = validatePlanDocument(plan);

    // Assert
    expect(validated.fingerprint).toBe(plan.fingerprint);
  });
});

describe("produced expectations are verified during execution", () => {
  test("a generated tree changed after its generator ran is stale before a recursive delete", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p gen && echo g > gen/file.txt",
        produces: "gen",
        mode: "staged",
      });
      b.add(deleteTree("gen", await b.expectationFor("gen")));
    });
    const run = testContext(root, (event) => {
      if (event.type === "step.done" && event.stepId === "s01") {
        writeFileSync(join(root, "gen/file.txt"), "a human edit\n");
      }
    });

    // Act
    const error = await expectGrootError(
      applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(error.details?.stepId).toBe("s02");
    const findings = (error.details?.findings ?? []) as { path: string }[];
    expect(findings.map((finding) => finding.path)).toEqual(["gen"]);
    expect(readFileSync(join(root, "gen/file.txt"), "utf8")).toBe("a human edit\n");
  });

  test("a generated tree that now holds a .git is never deleted (tree hashes ignore .git)", async () => {
    // Arrange — a human makes the generated app its own repository meanwhile.
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p gen && echo g > gen/file.txt",
        produces: "gen",
        mode: "staged",
      });
      b.add(deleteTree("gen", await b.expectationFor("gen")));
    });
    const run = testContext(root, (event) => {
      if (event.type === "step.done" && event.stepId === "s01") {
        mkdirSync(join(root, "gen/.git"));
        writeFileSync(join(root, "gen/.git/HEAD"), "ref: refs/heads/main\n");
      }
    });

    // Act
    const error = await expectGrootError(
      applyPlan(run.ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert — refused before its intent: nothing journaled, nothing backed up.
    expect(error.id).toBe("GROOT_E_CONFLICT");
    expect(error.details?.stepId).toBe("s02");
    expect(error.details?.paths).toEqual(["gen/.git"]);
    const intents = journalRecords(root, String(error.details?.operationId)).filter(
      (record) => record.type === "step.intent",
    );
    expect(intents.map((record) => (record.type === "step.intent" ? record.stepId : ""))).toEqual([
      "s01",
    ]);
    expect(readFileSync(join(root, "gen/.git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(readFileSync(join(root, "gen/file.txt"), "utf8")).toBe("g\n");
  });

  test("an unchanged generated tree is deleted as planned", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p gen && echo g > gen/file.txt",
        produces: "gen",
        mode: "staged",
      });
      b.add(deleteTree("gen", await b.expectationFor("gen")));
    });

    // Act
    const result = await apply(root, plan);

    // Assert
    expect(result.status).toBe("completed");
    expect(existsSync(join(root, "gen"))).toBe(false);
  });

  test("a producer without a recorded result for the path is a finding, not a pass", async () => {
    // Arrange
    const root = scratchProject({ "a.txt": "a\n" });

    // Act
    const finding = await checkExpectation(
      root,
      "a.txt",
      { state: "produced", byStep: "s01" },
      () => undefined,
    );

    // Assert
    expect(finding).not.toBeNull();
    expect(finding?.path).toBe("a.txt");
    expect(finding?.reason).toContain("s01");
  });
});

describe("Groot's state and .git are never action targets", () => {
  test("writes, edits, moves, and touches inside .groot are refused (any spelling)", async () => {
    // Arrange
    const root = scratchProject({ "a.txt": "a\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "x.txt", content: "x\n", description: "create x.txt" });
      addCommand(b, "true", { touches: ["log.txt"] });
    });
    const variants = [".groot/plans/evil.json", "./.groot/lock.json", ".GROOT/x", ".groot./x"];

    // Act
    const errors: GrootV2Error[] = [];
    for (const path of variants) {
      errors.push(
        await expectGrootError(
          apply(
            root,
            forge(plan, 0, (action) => ({ ...action, path })),
          ),
        ),
      );
    }
    const touches = await expectGrootError(
      apply(
        root,
        forge(plan, 1, (action) => ({ ...action, touches: [".groot/operations/x/plan.json"] })),
      ),
    );

    // Assert
    for (const error of errors) {
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(issuePaths(error)).toEqual(["actions.0.path"]);
    }
    expect(touches.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(touches)).toEqual(["actions.1.touches.0"]);
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("writes into .git (hooks, config) and moves out of it are refused", async () => {
    // Arrange
    const root = scratchProject({ ".git/config": "[core]\n", "a.txt": "a\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "x.txt", content: "x\n", description: "create x.txt" });
      b.add({
        type: "file.move",
        from: "a.txt",
        to: "b.txt",
        expect: await b.expectationFor("a.txt"),
        description: "rename a.txt",
        classes: ["fs.move"],
        reversible: true,
        compensation: "move it back",
      });
    });

    // Act
    const hook = await expectGrootError(
      apply(
        root,
        forge(plan, 0, (action) => ({ ...action, path: ".git/hooks/pre-commit" })),
      ),
    );
    const moved = await expectGrootError(
      apply(
        root,
        forge(plan, 1, (action) => ({
          ...action,
          from: ".git/config",
          expect: { state: "sha256", sha256: sha256Of("[core]\n") },
        })),
      ),
    );

    // Assert
    expect(hook.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(hook)).toEqual(["actions.0.path"]);
    expect(moved.id).toBe("GROOT_E_INVALID_DOCUMENT");
    expect(issuePaths(moved)).toEqual(["actions.1.from"]);
    expect(existsSync(join(root, ".git/hooks"))).toBe(false);
    expect(readFileSync(join(root, ".git/config"), "utf8")).toBe("[core]\n");
  });

  test("a symlink into .groot is refused when the step runs; nothing lands in the state directory", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    mkdirSync(join(ensureStateDir(root), "plans"), { recursive: true });
    symlinkSync(".groot", join(root, "state"));
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.writeFile({
        path: "state/plans/plan_forgedforgedforged.json",
        content: "{}\n",
        description: "plant a saved plan",
      });
    });

    // Act
    const error = await expectGrootError(apply(root, plan));

    // Assert
    expect(error.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    expect(error.details?.stepId).toBe("s02");
    expect(existsSync(join(root, ".groot/plans/plan_forgedforgedforged.json"))).toBe(false);
  });
});

describe("up-front freshness covers every action's own expectation", () => {
  test("an expectation missing from the preconditions still makes the plan stale before anything is written", async () => {
    // Arrange
    const root = scratchProject({ "config.txt": "v1\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.writeFile({
        path: "config.txt",
        content: "v2\n",
        description: "replace config.txt",
        replaceSha: sha256Of("v1\n"),
      });
    });
    const underDeclared = refingerprint({
      ...plan,
      preconditions: plan.preconditions.filter(
        (pre) => pre.type !== "path" || pre.path !== "config.txt",
      ),
    });
    writeFileSync(join(root, "config.txt"), "edited by a human\n");

    // Act
    const findings = await checkPlanFreshness(root, underDeclared);
    const error = await expectGrootError(apply(root, underDeclared));

    // Assert
    expect(findings.map((finding) => finding.path)).toEqual(["config.txt"]);
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(error.details?.operationId).toBeNull();
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("a declared precondition that disagrees with the action's expectation cannot mask it", async () => {
    // Arrange
    const root = scratchProject({ "config.txt": "v1\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      await b.writeFile({
        path: "config.txt",
        content: "v2\n",
        description: "replace config.txt",
        replaceSha: sha256Of("v1\n"),
      });
    });
    const masked = forge(plan, 1, (action) => ({
      ...action,
      expect: { state: "sha256", sha256: sha256Of("something else\n") },
    }));

    // Act
    const error = await expectGrootError(apply(root, masked));

    // Assert
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(error.details?.operationId).toBeNull();
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });
});
