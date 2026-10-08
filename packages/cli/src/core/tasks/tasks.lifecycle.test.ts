/**
 * Task lifecycle in a real temp git repository with a SIMULATED runner:
 * create → run (worktree, Groot commit, acceptance evidence) → awaiting
 * review → review (files, ownership, secrets, acceptance) → approve →
 * integrate (fresh worktree, merge, fresh checks, fast-forward only when the
 * main checkout is clean) → completed. Also: requested changes resume the
 * same session; ownership violations are reported.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Evidence } from "../contracts/evidence.ts";
import { Review, Task } from "../contracts/task.ts";
import { appFixture, blueprintFixture } from "../test-fixtures.ts";
import { readEvidence } from "../verify/store.ts";
import { createTask, integrateTask, readTask, reviewTask, runTask } from "./index.ts";
import { FIXED_MATH, removeTempProjects, tempProject } from "./testing/temp-project.ts";

const TIMEOUT = 180_000;
const GRACE = { interruptMs: 2000, terminateMs: 2000 };

afterAll(removeTempProjects);

describe("task lifecycle (simulated runner, real git)", () => {
  test(
    "create → run → awaiting-review → approve → integrate → completed (target fast-forwarded)",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH }, message: "Fixed add()." }],
      });
      const ctx = project.context();
      const baseHead = (await project.git("rev-parse", "HEAD")).trim();

      // Act — create and run
      const created = await createTask(ctx, project.root, {
        objective: "make the failing test pass without changing the test",
        runner: "claude-code",
        model: "opus",
        ownership: ["src/**"],
        accept: ["bun test"],
        limits: { maxTurns: 12, maxBudgetUsd: 0.75, wallTimeSec: 600 },
      });
      const ran = await runTask(ctx, project.root, created.id, { grace: GRACE });

      // Assert — the run
      expect(Task.safeParse(ran).success).toBe(true);
      expect(created).toMatchObject({
        status: "pending",
        base: { branch: "main", commit: baseHead },
        worktree: null,
      });
      expect(ran.status).toBe("awaiting-review");
      expect(ran.statusReason).toBeNull();
      expect(ran.worktree?.path).toBe(join(project.root, ".groot", "worktrees", created.id));
      expect(ran.worktree?.branch).toBe(`groot/task/${created.id}`);
      const [attempt] = ran.attempts;
      expect(attempt).toMatchObject({
        n: 1,
        status: "succeeded",
        resumedFrom: null,
        finalMessage: "Fixed add().",
      });
      expect(attempt?.usage.kind).toBe("observed-cost");
      expect(attempt?.eventsLog).toBe(`.groot/tasks/${created.id}/attempt-1.jsonl`);
      expect(existsSync(join(project.root, attempt?.eventsLog ?? "missing"))).toBe(true);
      expect(
        readFileSync(join(project.root, ".groot/tasks", created.id, "prompt.md"), "utf8"),
      ).toContain("## Objective");
      expect(ran.evidence).toHaveLength(1);
      const evidence = await readEvidence(project.root, ran.evidence[0] as string);
      expect(Evidence.safeParse(evidence).success).toBe(true);
      expect(evidence).toMatchObject({
        status: "pass",
        simulated: true,
        scope: { taskId: created.id },
      });
      expect(evidence.method.command?.argv).toEqual(["bun", "test"]);
      expect(
        (await project.git("log", "-1", "--format=%s", `groot/task/${created.id}`)).trim(),
      ).toBe(`groot: ${created.title}`);
      expect(readFileSync(join(project.root, "src/math.ts"), "utf8")).not.toBe(FIXED_MATH);

      // Act — review then approve
      const pending = await reviewTask(ctx, project.root, created.id);
      const approved = await reviewTask(ctx, project.root, created.id, { approve: true });

      // Assert — the review
      expect(Review.safeParse(approved).success).toBe(true);
      expect(pending.verdict).toBe("pending");
      expect(approved).toMatchObject({
        id: pending.id,
        verdict: "approved",
        reviewer: "human",
        ownershipViolations: [],
        secretFindings: [],
      });
      expect(approved.files).toEqual([
        {
          path: "src/math.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          withinOwnership: true,
        },
      ]);
      expect(approved.acceptance).toEqual([
        { criterion: "accept-1", status: "pass", evidence: ran.evidence[0] as string },
      ]);

      // Act — integrate
      const integrated = await integrateTask(ctx, project.root, created.id);

      // Assert — the integration
      expect(integrated.status).toBe("completed");
      expect(integrated.integration).toMatchObject({ status: "integrated", targetBranch: "main" });
      const mainHead = (await project.git("rev-parse", "main")).trim();
      expect(integrated.integration?.commit).toBe(mainHead);
      expect((await project.git("rev-parse", `groot/integrate/${created.id}`)).trim()).toBe(
        mainHead,
      );
      expect(readFileSync(join(project.root, "src/math.ts"), "utf8")).toBe(FIXED_MATH);
      expect(integrated.integration?.evidence.length).toBeGreaterThanOrEqual(2);
      for (const id of integrated.integration?.evidence ?? []) {
        expect((await readEvidence(project.root, id)).scope.taskId).toBe(created.id);
      }
      expect(integrated.worktree).toBeNull();
      expect(await project.git("worktree", "list")).not.toContain(".groot/worktrees");
      expect(await project.git("branch", "--list", "groot/*")).toContain(
        `groot/task/${created.id}`,
      );
      expect((await project.git("status", "--porcelain")).trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "a dirty main checkout is never touched: integration is blocked, the verified branch is left ready",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      await runTask(ctx, project.root, task.id, { grace: GRACE });
      await reviewTask(ctx, project.root, task.id, { approve: true });
      const before = (await project.git("rev-parse", "main")).trim();
      project.write("scratch.txt", "work in progress\n");

      // Act
      const blocked = await integrateTask(ctx, project.root, task.id);

      // Assert
      expect(blocked.status).toBe("blocked");
      expect(blocked.integration).toMatchObject({ status: "failed", commit: null });
      expect(blocked.statusReason).toContain("uncommitted changes");
      expect((await project.git("rev-parse", "main")).trim()).toBe(before);
      expect(readFileSync(join(project.root, "scratch.txt"), "utf8")).toBe("work in progress\n");
      const ready = (await project.git("rev-parse", `groot/integrate/${task.id}`)).trim();
      expect(ready).not.toBe(before);

      // Act — clean up and integrate again
      rmSync(join(project.root, "scratch.txt"));
      const done = await integrateTask(ctx, project.root, task.id);

      // Assert
      expect(done.status).toBe("completed");
      expect(readFileSync(join(project.root, "src/math.ts"), "utf8")).toBe(FIXED_MATH);
    },
    TIMEOUT,
  );

  test(
    "a structural/build check that could not run (blocked) gates integration like a failure",
    async () => {
      // Arrange — a registered project with a check that needs a tool this machine lacks.
      const project = await tempProject();
      const needsTool = {
        id: "structural.needs-tool",
        profile: "structural" as const,
        description: "needs a toolchain this machine lacks",
        checker: "structural.blueprint",
        capability: null,
        unit: null,
        needs: {
          network: false,
          processes: false,
          credentials: [],
          toolchains: ["groot-missing-toolchain"],
        },
      };
      project.write(
        "groot.json",
        JSON.stringify(
          blueprintFixture({
            apps: [appFixture({ id: "demo", path: "." })],
            verification: [needsTool],
          }),
        ),
      );
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "register");
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      await runTask(ctx, project.root, task.id, { grace: GRACE });
      await reviewTask(ctx, project.root, task.id, { approve: true });
      const before = (await project.git("rev-parse", "main")).trim();

      // Act
      const blocked = await integrateTask(ctx, project.root, task.id);

      // Assert
      expect(blocked.status).toBe("blocked");
      expect(blocked.integration).toMatchObject({ status: "failed", commit: null });
      expect(blocked.statusReason).toContain("structural.needs-tool");
      expect(blocked.statusReason).not.toContain("passed");
      expect((await project.git("rev-parse", "main")).trim()).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "a conflicting target branch makes integration `conflicted`: merge aborted, cleaned up, target untouched",
    async () => {
      // Arrange — the task fixes add(); meanwhile main rewrites the same line.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      await runTask(ctx, project.root, task.id, { grace: GRACE });
      await reviewTask(ctx, project.root, task.id, { approve: true });
      project.write("src/math.ts", FIXED_MATH.replace("a + b", "b + a"));
      await project.git("commit", "-q", "-am", "main: rewrite add");
      const before = (await project.git("rev-parse", "main")).trim();

      // Act
      const conflicted = await integrateTask(ctx, project.root, task.id);

      // Assert
      expect(conflicted.status).toBe("blocked");
      expect(conflicted.integration).toMatchObject({
        status: "conflicted",
        commit: null,
        evidence: [],
      });
      expect(conflicted.statusReason).toContain("src/math.ts");
      expect((await project.git("rev-parse", "main")).trim()).toBe(before);
      expect((await project.git("status", "--porcelain")).trim()).toBe("");
      expect(await project.git("branch", "--list", `groot/integrate/${task.id}`)).toBe("");
      expect(await project.git("worktree", "list")).not.toContain(`integrate-${task.id}`);
    },
    TIMEOUT,
  );

  test(
    "ownership violations and secret-looking additions are reported by the review",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: {
              "src/math.ts": FIXED_MATH,
              "README.md": "# demo\n",
              "src/config.ts": 'export const API_KEY = "abcd1234efgh5678";\n',
            },
          },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        ownership: ["src/**"],
        accept: ["bun test"],
      });
      await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Act
      const review = await reviewTask(ctx, project.root, task.id);

      // Assert
      expect(review.ownershipViolations).toEqual(["README.md"]);
      expect(review.files.find((file) => file.path === "README.md")).toMatchObject({
        status: "added",
        withinOwnership: false,
      });
      expect(review.secretFindings).toEqual([
        "src/config.ts:1 — literal value assigned to API_KEY",
      ]);
      expect(JSON.stringify(review)).not.toContain("abcd1234efgh5678");
    },
    TIMEOUT,
  );

  test(
    "requested changes send the task back; the next run resumes the same session with the notes",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      const first = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Act
      const review = await reviewTask(ctx, project.root, task.id, {
        requestChanges: "Also add a doc comment to add().",
      });
      const sentBack = await readTask(project.root, task.id);
      const second = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(review.verdict).toBe("changes-requested");
      expect(sentBack.status).toBe("pending");
      expect(sentBack.statusReason).toContain("changes requested");
      expect(second.status).toBe("awaiting-review");
      const [, resumed] = project.fakes.records();
      const session = first.attempts[0]?.sessionId ?? "missing";
      expect(resumed?.argv[resumed.argv.indexOf("--resume") + 1]).toBe(session);
      expect(resumed?.stdin).toContain("Also add a doc comment to add().");
      expect(second.attempts[1]).toMatchObject({ resumedFrom: first.attempts[0]?.sessionId });
      await expect(integrateTask(ctx, project.root, task.id)).rejects.toThrow(/approved review/);
    },
    TIMEOUT,
  );
});
