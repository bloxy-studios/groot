/**
 * Generator recovery never guesses: a destination is reconciled only when the
 * generator's recorded result is complete and unchanged, anything Groot
 * cannot attribute to the generator stops resume at a retry/skip decision,
 * `.git` and `.groot` are never removed, and promotion refuses a destination
 * that stopped being fresh while the generator ran (no human file is
 * overwritten or deleted). Crashes after the effect are simulated by
 * truncating the journal; real SIGKILLs are in commands/recovery-cli.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { applyPlan, resumeOperation } from "./index.ts";
import {
  addGenerator,
  buildPlan,
  crashAfterEffect,
  journalRecords,
  permissive,
  removeScratchDirs,
  scratchProject,
  snapshot,
  testContext,
} from "./test-support.ts";

afterAll(removeScratchDirs);

/** Each test runs real generator processes, some twice. */
const TIMEOUT = 60_000;

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

function apply(root: string, plan: OperationPlan) {
  return applyPlan(testContext(root).ctx, { plan, root, policy: permissive, command: "init" });
}

function lastOutcome(root: string, operationId: string, stepId: string): string | null {
  const done = journalRecords(root, operationId).filter(
    (record) => record.type === "step.done" && record.stepId === stepId,
  );
  const last = done.at(-1);
  return last?.type === "step.done" ? last.outcome : null;
}

/** A generator producing the project root: staged (into basename(root)) or in place (into "."). */
async function rootGenerator(root: string, mode: "staged" | "in-place"): Promise<OperationPlan> {
  const dir = mode === "staged" ? basename(root) : ".";
  return buildPlan(root, async (b) => {
    addGenerator(b, {
      script: `mkdir -p ${dir}/src && echo '<h1/>' > ${dir}/index.html && echo a > ${dir}/src/a.ts`,
      produces: ".",
      mode,
    });
  });
}

/** What a human does in the project root while the operation sits interrupted. */
function humanWork(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "MY-NOTES.md"), "mine\n");
}

describe("generator steps interrupted after their effect", () => {
  for (const mode of ["staged", "in-place"] as const) {
    test(
      `${mode}: a complete, unchanged result is reconciled, not regenerated`,
      async () => {
        // Arrange
        const root = scratchProject();
        const applied = await apply(root, await rootGenerator(root, mode));
        const generated = snapshot(root);
        crashAfterEffect(root, applied.operationId, "s01");

        // Act
        const resumed = await resumeOperation(testContext(root).ctx, root, applied.operationId);

        // Assert
        expect(resumed.status).toBe("completed");
        expect(lastOutcome(root, applied.operationId, "s01")).toBe("reconciled");
        expect(snapshot(root)).toEqual(generated);
      },
      TIMEOUT,
    );

    test(
      `${mode}: files a human added meanwhile block resume; nothing is deleted`,
      async () => {
        // Arrange
        const root = scratchProject();
        const applied = await apply(root, await rootGenerator(root, mode));
        crashAfterEffect(root, applied.operationId, "s01");
        humanWork(root);

        // Act
        const error = await expectGrootError(
          resumeOperation(testContext(root).ctx, root, applied.operationId),
        );

        // Assert
        expect(error.id).toBe("GROOT_E_BLOCKED");
        expect(error.details?.gate).toBe("interrupted-step");
        expect(error.message).toContain("MY-NOTES.md");
        expect(readFileSync(join(root, "MY-NOTES.md"), "utf8")).toBe("mine\n");
        expect(readFileSync(join(root, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      },
      TIMEOUT,
    );
  }

  test(
    "--retry-step never removes a .git that appeared meanwhile: conflict, nothing deleted",
    async () => {
      // Arrange
      const root = scratchProject();
      const applied = await apply(root, await rootGenerator(root, "in-place"));
      crashAfterEffect(root, applied.operationId, "s01");
      humanWork(root);

      // Act
      const error = await expectGrootError(
        resumeOperation(testContext(root).ctx, root, applied.operationId, { retryStep: "s01" }),
      );

      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details?.paths).toEqual([".git"]);
      expect(readFileSync(join(root, "MY-NOTES.md"), "utf8")).toBe("mine\n");
      expect(existsSync(join(root, "index.html"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "--retry-step regenerates when only the generator's own output is in the way",
    async () => {
      // Arrange
      const root = scratchProject();
      const applied = await apply(root, await rootGenerator(root, "in-place"));
      const generated = snapshot(root);
      crashAfterEffect(root, applied.operationId, "s01");
      writeFileSync(join(root, "index.html"), "half-written\n");

      // Act
      const resumed = await resumeOperation(testContext(root).ctx, root, applied.operationId, {
        retryStep: "s01",
      });

      // Assert
      expect(resumed.status).toBe("completed");
      expect(lastOutcome(root, applied.operationId, "s01")).toBe("applied");
      expect(snapshot(root)).toEqual(generated);
    },
    TIMEOUT,
  );
});

describe("staged promotion", () => {
  test(
    "a destination that stopped being fresh while the generator ran is refused; nothing is overwritten",
    async () => {
      // Arrange — the "generator" also writes into the project, as a human might meanwhile.
      const root = scratchProject();
      const plan = await buildPlan(root, async (b) => {
        addGenerator(b, {
          script: `mkdir -p web && echo generated > web/index.html && mkdir -p '${root}/apps/web' && echo mine > '${root}/apps/web/index.html'`,
          produces: "apps/web",
          mode: "staged",
        });
      });

      // Act
      const error = await expectGrootError(apply(root, plan));

      // Assert
      expect(error.id).toBe("GROOT_E_STALE_PLAN");
      expect(readFileSync(join(root, "apps/web/index.html"), "utf8")).toBe("mine\n");
    },
    TIMEOUT,
  );

  test(
    "a generator failing in its stage leaves files created meanwhile in the root alone",
    async () => {
      // Arrange
      const root = scratchProject();
      const name = basename(root);
      const plan = await buildPlan(root, async (b) => {
        addGenerator(b, {
          script: `mkdir -p ${name} && echo x > ${name}/x && echo mine > '${root}/notes.md' && exit 3`,
          produces: ".",
          mode: "staged",
        });
      });

      // Act
      const error = await expectGrootError(apply(root, plan));

      // Assert
      expect(error.id).toBe("GROOT_E_GENERATOR");
      expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("mine\n");
    },
    TIMEOUT,
  );
});
