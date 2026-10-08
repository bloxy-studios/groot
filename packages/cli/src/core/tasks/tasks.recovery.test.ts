/**
 * Recovery and concurrency with a SIMULATED runner in real git repositories:
 * a runner orphaned by a killed Groot is stopped before the task runs again
 * (and only reported by show/list), a session that never existed or was
 * purged is replaced by a fresh one, corrupt documents are invalid (not
 * internal errors), a claim re-checks the task under the lock, a review
 * decision is written under the lock against a fresh read, and a fresh-start
 * retry keeps the coordinator's project context.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../contracts/task.ts";
import { groupMembers } from "../runners/supervise.ts";
import { createTask, listTasks, readTask, reviewTask, runTask } from "./index.ts";
import { withProjectLock } from "./lock.ts";
import * as store from "./store.ts";
import {
  FIXED_MATH,
  removeTempProjects,
  type TempProject,
  tempProject,
} from "./testing/temp-project.ts";

const TIMEOUT = 180_000;
const GRACE = { interruptMs: 2000, terminateMs: 2000 };
const DEAD_PID = 999_999;
const NEVER_STARTED = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

afterAll(removeTempProjects);

/** Rewrite a task as left `running` by a Groot process that no longer exists. */
function crash(project: TempProject, task: Task, runner?: { pgid: number; startedAt: number }) {
  writeFileSync(
    store.taskPaths.file(project.root, task.id),
    JSON.stringify({ ...task, status: "running", statusReason: null }),
  );
  writeFileSync(
    store.taskPaths.marker(project.root, task.id),
    JSON.stringify({ pid: DEAD_PID, host: hostname(), at: new Date().toISOString(), runner }),
  );
}

/** Resolve true when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    timeout,
  ]);
}

describe("a runner orphaned by a killed groot", () => {
  test(
    "is stopped before the task runs again; show/list only report it",
    async () => {
      // Arrange — the dead groot recorded a runner group that is still alive.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });
      const orphan = Bun.spawn(["sleep", "120"], { detached: true, stdout: "ignore" });
      crash(project, task, { pgid: orphan.pid, startedAt: Date.now() });

      // Act — read first (nothing may change), then run.
      const shown = await readTask(project.root, task.id);
      const listed = await listTasks(project.root);
      const aliveAfterShow = (await groupMembers(orphan.pid)).length > 0;
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(shown.status).toBe("running");
      expect(shown.statusReason).toContain(`process group ${orphan.pid}`);
      expect(listed[0]?.statusReason).toContain("unsupervised");
      expect(aliveAfterShow).toBe(true);
      expect(ran.status).toBe("awaiting-review");
      expect(await groupMembers(orphan.pid)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "show/list report an abandoned run as interrupted without writing anything",
    async () => {
      // Arrange
      const project = await tempProject();
      const ctx = project.context();
      const task = await createTask(ctx, project.root, { objective: "fix add" });
      crash(project, task);

      // Act
      const shown = await readTask(project.root, task.id);
      const [listed] = await listTasks(project.root);

      // Assert
      expect(shown.status).toBe("interrupted");
      expect(shown.statusReason).toContain("exited unexpectedly");
      expect(listed?.status).toBe("interrupted");
      expect((await store.readTask(project.root, task.id)).status).toBe("running");
    },
    TIMEOUT,
  );
});

describe("sessions that do not exist", () => {
  test(
    "a session pre-assigned by a groot killed before the runner created it is not resumed",
    async () => {
      // Arrange — attempt 1 was recorded with its id, but the log shows no session.
      const project = await tempProject();
      project.fakes.scenario({
        sessions: "known",
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const created = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
        limits: { maxAttempts: 1 },
      });
      const attempt = {
        n: 1,
        runner: "claude-code" as const,
        sessionId: NEVER_STARTED,
        resumedFrom: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running" as const,
        exitCode: null,
        usage: {
          kind: "unavailable" as const,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          turns: null,
          durationMs: 0,
          source: "attempt in progress",
        },
        eventsLog: `.groot/tasks/${created.id}/attempt-1.jsonl`,
        finalMessage: null,
        error: null,
      };
      writeFileSync(
        store.taskPaths.attemptLog(project.root, created.id, 1),
        `${JSON.stringify({ type: "groot.spawn", pid: DEAD_PID, argv: [], cwd: project.root })}\n`,
      );
      crash(project, { ...created, attempts: [attempt] });

      // Act
      const ran = await runTask(ctx, project.root, created.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("awaiting-review");
      expect(ran.attempts[0]).toMatchObject({ status: "interrupted", sessionId: null });
      const [record] = project.fakes.records();
      expect(record?.argv).toContain("--session-id");
      expect(record?.argv).not.toContain("--resume");
    },
    TIMEOUT,
  );

  test(
    "a purged resume target is replaced by a fresh session (no attempt spent) that keeps the notes",
    async () => {
      // Arrange — one finished attempt, then the runner forgets its session.
      const project = await tempProject();
      project.fakes.scenario({
        sessions: "known",
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const created = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
        limits: { maxAttempts: 1 },
      });
      const first = await runTask(ctx, project.root, created.id, { grace: GRACE });
      await reviewTask(ctx, project.root, created.id, { requestChanges: "Add a doc comment." });
      project.fakes.forgetSessions();

      // Act
      const second = await runTask(ctx, project.root, created.id, { grace: GRACE });
      await reviewTask(ctx, project.root, created.id, { requestChanges: "Shorter, please." });
      const third = await runTask(ctx, project.root, created.id, { grace: GRACE });

      // Assert
      expect(second.status).toBe("awaiting-review");
      expect(second.attempts.map((attempt) => attempt.status)).toEqual([
        "succeeded",
        "failed",
        "succeeded",
      ]);
      expect(second.attempts[1]?.error?.id).toBe("GROOT_E_NOT_RESUMABLE");
      const records = project.fakes.records();
      const fresh = records[2];
      expect(fresh?.argv).toContain("--session-id");
      expect(fresh?.stdin).toContain("Add a doc comment.");
      expect(fresh?.stdin).toContain("## Objective");
      // The next resume continues the NEW session, never the purged one.
      const resumed = records.at(-1);
      expect(resumed?.argv[resumed.argv.indexOf("--resume") + 1]).toBe(
        second.attempts[2]?.sessionId ?? "missing",
      );
      expect(second.attempts[2]?.sessionId).not.toBe(first.attempts[0]?.sessionId);
      expect(third.status).toBe("awaiting-review");
    },
    TIMEOUT,
  );
});

describe("corrupt documents", () => {
  test("an unparseable task or review is an invalid document, a missing one is not found", async () => {
    // Arrange
    const root = mkdtempSync(join(tmpdir(), "groot-task-store-"));
    const id = "task_0000000001abcdef";
    mkdirSync(store.taskPaths.dir(root, id), { recursive: true });
    writeFileSync(store.taskPaths.file(root, id), "{ not json");
    mkdirSync(join(root, ".groot", "reviews"), { recursive: true });
    writeFileSync(store.taskPaths.review(root, "rev_0000000001abcdef"), "[]");

    // Act / Assert
    await expect(store.readTask(root, id)).rejects.toMatchObject({
      id: "GROOT_E_INVALID_DOCUMENT",
    });
    await expect(store.readReview(root, "rev_0000000001abcdef")).rejects.toMatchObject({
      id: "GROOT_E_INVALID_DOCUMENT",
    });
    await expect(store.readReview(root, "rev_0000000002abcdef")).rejects.toMatchObject({
      id: "GROOT_E_NOT_FOUND",
    });
  });
});

describe("races", () => {
  test(
    "a claim re-checks the task under the lock: one completed meanwhile is not run again",
    async () => {
      // Arrange — preflight is slow; meanwhile another process finishes the task.
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "success" }], probeDelayMs: 1500 });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, { objective: "fix add" });

      // Act
      const running = runTask(ctx, project.root, task.id, { grace: GRACE });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          readFileSync(join(project.fakes.dir, "probing"));
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      writeFileSync(
        store.taskPaths.file(project.root, task.id),
        JSON.stringify({ ...task, status: "awaiting-review" }),
      );

      // Assert
      await expect(running).rejects.toMatchObject({ id: "GROOT_E_TASK_STATE" });
      expect(project.fakes.records()).toEqual([]);
      expect((await store.readTask(project.root, task.id)).status).toBe("awaiting-review");
    },
    TIMEOUT,
  );

  test(
    "a review decision waits for the project lock and refuses a task that changed meanwhile",
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

      // Act — hold the lock while a decision is attempted; change the task meanwhile.
      let pending: Promise<unknown> = Promise.resolve();
      const settledWhileLocked = await withProjectLock(project.root, "test", async () => {
        pending = reviewTask(ctx, project.root, task.id, { approve: true });
        const settled = await settlesWithin(pending, 5000);
        const current = await store.readTask(project.root, task.id);
        store.writeTask(project.root, store.touch(current, { statusReason: "concurrent edit" }));
        return settled;
      });

      // Assert
      expect(settledWhileLocked).toBe(false);
      await expect(pending).rejects.toMatchObject({ id: "GROOT_E_TASK_STATE" });
      const stored = await store.readTask(project.root, task.id);
      expect(stored).toMatchObject({ statusReason: "concurrent edit", review: null });
    },
    TIMEOUT,
  );
});

describe("fresh-start retries", () => {
  test(
    "keep the coordinator's project context",
    async () => {
      // Arrange — attempt 1 dies before a session exists, attempt 2 fixes it.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "crash" }, { mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act
      const done = await runTask(ctx, project.root, task.id, {
        grace: GRACE,
        contextProvider: async () => "CONTEXT-MARKER: apps/api is a Hono app",
      });

      // Assert
      expect(done.status).toBe("awaiting-review");
      const [crashed, retried] = project.fakes.records();
      expect(crashed?.stdin).toContain("CONTEXT-MARKER");
      expect(retried?.argv).toContain("--session-id");
      expect(retried?.stdin).toContain("CONTEXT-MARKER");
      expect(retried?.stdin).toContain("did not all pass");
    },
    TIMEOUT,
  );
});
