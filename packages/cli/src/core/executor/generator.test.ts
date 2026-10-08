/**
 * Generator steps and tree-shaped effects: staged generation promoted into
 * the project root (init in place) and rolled back without touching .groot/,
 * in-place generation with git scrubbing, recursive deletes of a generated
 * tree restored from its tree backup, and the preconditions actions imply
 * (fresh destination, absent move target) refused before anything is written.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GrootV2Error } from "../errors.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import { applyPlan, checkPlanFreshness, rollbackOperation } from "./index.ts";
import {
  buildPlan,
  operationIds,
  permissive,
  scratchProject,
  snapshot,
  testContext,
} from "./test-support.ts";

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

function addGenerator(
  builder: PlanBuilder,
  options: {
    script: string;
    produces: string;
    mode: "staged" | "in-place";
    cwd?: string;
    scrubGit?: boolean;
  },
): string {
  return builder.add({
    type: "generator.run",
    generator: { package: "fake-generator", range: "1", version: "1.0.0", integrity: null },
    argv: ["sh", "-c", options.script],
    cwd: options.cwd ?? ".",
    mode: options.mode,
    produces: options.produces,
    stdin: null,
    timeoutMs: 60_000,
    scrubGit: options.scrubGit ?? true,
    predictable: false,
    description: `generate ${options.produces}`,
    classes: ["generator"],
    reversible: true,
    compensation: `delete ${options.produces}`,
  });
}

describe("generators", () => {
  test("staged output promoted into the project root rolls back without touching .groot", async () => {
    // Arrange
    const root = scratchProject();
    const name = basename(root); // a staged generator creates basename(produces) in its stage
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: `mkdir -p ${name}/src && echo '<h1/>' > ${name}/index.html && echo a > ${name}/src/a.ts && git init -q ${name}`,
        produces: ".",
        mode: "staged",
      });
    });

    // Act
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "init",
    });
    const generated = snapshot(root);
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(applied.status).toBe("completed");
    expect(Object.keys(generated)).toEqual(["index.html", "src/", "src/a.ts"]);
    expect(existsSync(join(root, ".git"))).toBe(false); // scrubbed
    expect(snapshot(root)).toEqual(before);
    expect(operationIds(root)).toEqual([applied.operationId]); // .groot survived the rollback
  });

  test("in-place generation runs in its cwd and scrubs a generator-created .git", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p web && echo hi > web/index.html && git init -q web",
        produces: "apps/web",
        mode: "in-place",
        cwd: "apps",
      });
    });

    // Act
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "add",
    });

    // Assert
    expect(applied.status).toBe("completed");
    expect(readFileSync(join(root, "apps/web/index.html"), "utf8")).toBe("hi\n");
    expect(existsSync(join(root, "apps/web/.git"))).toBe(false);
  });

  test("a failing generator leaves nothing behind and the step fails", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p web && echo partial > web/x && exit 4",
        produces: "apps/web",
        mode: "in-place",
        cwd: "apps",
      });
    });

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "add" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_GENERATOR");
    expect(snapshot(root)).toEqual(before); // output and the created apps/ parent are gone
  });

  test("a recursive delete of a generated tree is undone from its tree backup", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      addGenerator(b, {
        script: "mkdir -p gen && echo g > gen/file.txt",
        produces: "gen",
        mode: "staged",
      });
      b.add({
        type: "file.delete",
        path: "gen",
        expect: await b.expectationFor("gen"),
        recursive: true,
        description: "delete the generated tree",
        classes: ["fs.delete"],
        reversible: true,
        compensation: "restore gen from backup",
      });
    });

    // Act
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const afterApply = existsSync(join(root, "gen"));
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(afterApply).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("implied preconditions", () => {
  test("a non-empty generator destination makes the plan stale before anything is written", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "first.txt", content: "1\n", description: "create first.txt" });
      addGenerator(b, { script: "mkdir web", produces: "apps/web", mode: "staged" });
    });
    mkdirSync(join(root, "apps/web"), { recursive: true });
    writeFileSync(join(root, "apps/web/keep.txt"), "mine\n");

    // Act
    const findings = await checkPlanFreshness(root, plan);
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(findings.map((finding) => finding.path)).toEqual(["apps/web"]);
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(existsSync(join(root, "first.txt"))).toBe(false);
    expect(existsSync(join(root, ".groot"))).toBe(false);
  });

  test("an occupied move target makes the plan stale before anything is written", async () => {
    // Arrange
    const root = scratchProject({ "old.txt": "old\n" });
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "file.move",
        from: "old.txt",
        to: "new.txt",
        expect: await b.expectationFor("old.txt"),
        description: "rename old.txt",
        classes: ["fs.move"],
        reversible: true,
        compensation: "move it back",
      });
    });
    writeFileSync(join(root, "new.txt"), "someone else's\n");

    // Act
    const error = await expectGrootError(
      applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "apply" }),
    );

    // Assert
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect((error.details?.findings as { path: string }[] | undefined)?.map((f) => f.path)).toEqual(
      ["new.txt"],
    );
    expect(readFileSync(join(root, "old.txt"), "utf8")).toBe("old\n");
  });

  test("a move is applied and rolled back", async () => {
    // Arrange
    const root = scratchProject({ "old.txt": "old\n" });
    const before = snapshot(root);
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "file.move",
        from: "old.txt",
        to: "nested/new.txt",
        expect: await b.expectationFor("old.txt"),
        description: "move old.txt",
        classes: ["fs.move"],
        reversible: true,
        compensation: "move it back",
      });
    });

    // Act
    const applied = await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: permissive,
      command: "apply",
    });
    const moved = readFileSync(join(root, "nested/new.txt"), "utf8");
    await rollbackOperation(testContext(root).ctx, root, applied.operationId);

    // Assert
    expect(moved).toBe("old\n");
    expect(snapshot(root)).toEqual(before);
  });
});
