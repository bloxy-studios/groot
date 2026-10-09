/**
 * Task scheduling and recovery with a SIMULATED runner in real git repos:
 * dependency blocking, ready-set selection, overlapping ownership
 * serialized (and disjoint ownership run in parallel), bounded retry that
 * resumes the same session with the failing check output, blocked runners
 * (config-incompatible Codex, unavailable model), and interruption + resume.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GrootEvent } from "../contracts/envelope.ts";
import {
  createTask,
  integrateTask,
  readTask,
  resumeTask,
  reviewTask,
  runReadyTasks,
  runTask,
} from "./index.ts";
import { taskPaths } from "./store.ts";
import {
  BROKEN_MATH,
  FIXED_MATH,
  removeTempProjects,
  tempProject,
} from "./testing/temp-project.ts";

const TIMEOUT = 180_000;
const GRACE = { interruptMs: 2000, terminateMs: 2000 };

afterAll(removeTempProjects);

/** Index of the first event matching type + task. */
function at(log: readonly GrootEvent[], type: string, taskId: string): number {
  return log.findIndex((event) => event.type === type && event.taskId === taskId);
}

describe("dependencies and the ready set", () => {
  test(
    "a dependent task is blocked until its dependency is completed; --ready runs only what can start",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const first = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      const second = await createTask(ctx, project.root, {
        objective: "document add",
        dependsOn: [first.id],
        accept: ["bun test"],
      });

      // Act
      const blocked = await runTask(ctx, project.root, second.id, { grace: GRACE });
      const readyRun = await runReadyTasks(ctx, project.root, { parallel: 2, grace: GRACE });

      // Assert
      expect(blocked.status).toBe("blocked");
      expect(blocked.statusReason).toContain(`waiting on ${first.id} (pending)`);
      expect(blocked.worktree).toBeNull();
      expect(readyRun.tasks.map((task) => [task.id, task.status])).toEqual([
        [first.id, "awaiting-review"],
      ]);
      expect(readyRun.failures).toEqual([]);

      // Act — complete the dependency, then the dependent becomes ready
      await reviewTask(ctx, project.root, first.id, { approve: true });
      await integrateTask(ctx, project.root, first.id);
      const next = await runReadyTasks(ctx, project.root, { parallel: 2, grace: GRACE });

      // Assert
      expect(next.tasks.map((task) => [task.id, task.status])).toEqual([
        [second.id, "awaiting-review"],
      ]);
      await expect(
        createTask(ctx, project.root, { objective: "x", dependsOn: ["task_doesnotexist0"] }),
      ).rejects.toThrow(/No task/);
    },
    TIMEOUT,
  );

  test(
    "overlapping ownership runs one at a time; disjoint ownership runs in parallel",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH }, delayMs: 1500 }],
      });
      const ctx = project.context();
      const a = await createTask(ctx, project.root, {
        objective: "A",
        ownership: ["src/**"],
        accept: ["bun test"],
      });
      const b = await createTask(ctx, project.root, {
        objective: "B",
        ownership: ["src/math.ts"],
        accept: ["bun test"],
      });
      const c = await createTask(ctx, project.root, {
        objective: "C",
        ownership: ["docs/**"],
        accept: ["bun test"],
      });

      // Act
      const results = await runReadyTasks(ctx, project.root, { parallel: 3, grace: GRACE });

      // Assert
      expect(results.tasks.map((task) => task.status)).toEqual([
        "awaiting-review",
        "awaiting-review",
        "awaiting-review",
      ]);
      const log = ctx.log;
      // A and C overlap in time (disjoint ownership)…
      expect(at(log, "task.running", c.id)).toBeLessThan(at(log, "task.awaiting-review", a.id));
      // …while B (inside A's src/**) starts only after A finished.
      expect(at(log, "task.running", b.id)).toBeGreaterThan(at(log, "task.awaiting-review", a.id));
    },
    TIMEOUT,
  );
});

describe("bounded retry", () => {
  test(
    "failing acceptance resumes the SAME session with the failing output, then passes",
    async () => {
      // Arrange — the first attempt leaves the bug, the second fixes it.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [
          { mode: "success", edits: { "src/math.ts": BROKEN_MATH.replace("a - b", "a * b") } },
          { mode: "success", edits: { "src/math.ts": FIXED_MATH } },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act
      const done = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(done.status).toBe("awaiting-review");
      expect(done.attempts.map((attempt) => attempt.status)).toEqual(["succeeded", "succeeded"]);
      expect(done.evidence).toHaveLength(2);
      const [first, second] = project.fakes.records();
      const session = done.attempts[0]?.sessionId ?? "missing";
      expect(first?.argv[first.argv.indexOf("--session-id") + 1]).toBe(session);
      expect(second?.argv).not.toContain("--session-id");
      expect(second?.argv[second.argv.indexOf("--resume") + 1]).toBe(session);
      expect(second?.stdin).toContain("did not all pass");
      expect(second?.stdin).toContain("adds two numbers");
      expect(done.attempts[1]?.resumedFrom).toBe(session);
    },
    TIMEOUT,
  );

  test(
    "attempts are bounded: still failing after maxAttempts → failed with the reason",
    async () => {
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "success" }] });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
        limits: { maxAttempts: 2 },
      });
      const failed = await runTask(ctx, project.root, task.id, { grace: GRACE });
      expect(failed.status).toBe("failed");
      expect(failed.attempts).toHaveLength(2);
      expect(failed.statusReason).toContain("acceptance failed");
      expect(failed.statusReason).toContain("attempt 2 of 2");
      expect(project.fakes.records()).toHaveLength(2);
    },
    TIMEOUT,
  );
});

describe("blocked runners", () => {
  test(
    "Codex that cannot load its config is blocked with the exact cause; nothing is created",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "success" }], auth: "config-error" });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        runner: "codex",
        accept: ["bun test"],
      });

      // Act
      const blocked = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(task.limits.maxBudgetUsd).toBeNull();
      expect(blocked.status).toBe("blocked");
      expect(blocked.statusReason).toContain("Codex is blocked (config-incompatible)");
      expect(blocked.statusReason).toContain("config.toml:2:26");
      expect(blocked.statusReason).toContain("never edits");
      expect(blocked.worktree).toBeNull();
      expect(blocked.attempts).toEqual([]);
      expect(project.fakes.records()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "Codex running out of usage mid-run blocks the task with the cause instead of retrying",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "usage-limit" }] });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        runner: "codex",
        accept: ["bun test"],
      });

      // Act
      const blocked = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(blocked.status).toBe("blocked");
      expect(blocked.statusReason).toContain("Codex is blocked (quota)");
      expect(blocked.attempts).toHaveLength(1);
      expect(blocked.attempts[0]?.error).toMatchObject({
        id: "GROOT_E_BLOCKED",
        details: { cause: "quota" },
      });
      expect(blocked.evidence).toEqual([]);
      expect(project.fakes.records()).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "an unavailable model (API 404 reported as subtype success) blocks the task instead of retrying",
    async () => {
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "api-error" }] });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        model: "sonnet",
        accept: ["bun test"],
      });
      const blocked = await runTask(ctx, project.root, task.id, { grace: GRACE });
      expect(blocked.status).toBe("blocked");
      expect(blocked.statusReason).toContain('Model "sonnet" is not available');
      expect(blocked.attempts).toHaveLength(1);
      expect(blocked.attempts[0]?.error?.id).toBe("GROOT_E_RUNNER_UNAVAILABLE");
    },
    TIMEOUT,
  );
});

describe("interruption and resume", () => {
  test(
    "abort cancels the runner (no survivors), keeps the session, and resume continues it",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "hang", grandchild: true }] });
      const controller = new AbortController();
      const ctx = project.context(controller.signal);
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act — interrupt mid-run
      const running = runTask(ctx, project.root, task.id, { grace: GRACE });
      const pid = await project.fakes.waitReady();
      controller.abort();
      const interrupted = await running;

      // Assert
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.statusReason).toContain(`groot task resume ${task.id}`);
      expect(interrupted.attempts[0]).toMatchObject({ status: "interrupted" });
      const session = interrupted.attempts[0]?.sessionId ?? "missing";
      expect(session).not.toBe("missing");
      expect(existsSync(taskPaths.marker(project.root, task.id))).toBe(false);
      expect(() => process.kill(-pid, 0)).toThrow();

      // Act — resume
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const resumed = await resumeTask(project.context(), project.root, task.id, { grace: GRACE });

      // Assert
      expect(resumed.status).toBe("awaiting-review");
      const [record] = project.fakes.records().slice(-1);
      expect(record?.argv[record.argv.indexOf("--resume") + 1]).toBe(session);
      expect(record?.stdin).toContain("interrupted");
    },
    TIMEOUT,
  );

  test(
    "a task left `running` by a dead process is reconciled to interrupted and can be resumed",
    async () => {
      // Arrange — simulate a crash: status running, marker from a dead pid.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      const done = await runTask(ctx, project.root, task.id, { grace: GRACE });
      const crashed = {
        ...done,
        status: "running" as const,
        attempts: [
          { ...(done.attempts[0] as (typeof done.attempts)[0]), status: "running" as const },
        ],
      };
      writeFileSync(taskPaths.file(project.root, task.id), JSON.stringify(crashed));
      writeFileSync(
        taskPaths.marker(project.root, task.id),
        JSON.stringify({
          pid: 999_999,
          host: (await import("node:os")).hostname(),
          at: new Date().toISOString(),
        }),
      );

      // Act
      const resumed = await resumeTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(resumed.status).toBe("awaiting-review");
      expect(resumed.attempts[0]?.status).toBe("interrupted");
      expect((await readTask(project.root, task.id)).attempts).toHaveLength(2);
      expect(existsSync(join(project.root, ".groot", "worktrees", task.id))).toBe(true);
    },
    TIMEOUT,
  );
});
