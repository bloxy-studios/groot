/**
 * JobTracker: an operation can have several jobs over its life (apply, then
 * resume or rollback). Lookups by operation id must reach the one that is
 * running now, and cancelling an operation must stop every job still working
 * on it.
 */
import { describe, expect, test } from "bun:test";
import { type Job, JobTracker } from "./jobs.ts";

/** A job that runs until its signal aborts (like the executor, it checks the signal first). */
function untilAborted(jobs: JobTracker, kind: string, key: string): Job<unknown> {
  return jobs.start(
    kind,
    key,
    (signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
}

describe("JobTracker", () => {
  test("find(operation) reaches the running resume, not the finished apply; cancel stops it", async () => {
    const jobs = new JobTracker();
    const apply = jobs.start("apply", "plan_1", async () => "interrupted");
    apply.operationId = "op_1";
    expect(await jobs.wait(apply, 5_000)).toBe(true);
    const resume = untilAborted(jobs, "resume", "resume:op_1");
    resume.operationId = "op_1";

    expect(jobs.find("op_1")).toBe(resume);
    expect(jobs.cancel("op_1")).toBe(true);
    expect(resume.controller.signal.aborted).toBe(true);
    expect(await jobs.wait(resume, 5_000)).toBe(true);

    // Nothing runs any more: the newest job is the answer, and there is nothing to cancel.
    expect(jobs.find("op_1")).toBe(resume);
    expect(jobs.cancel("op_1")).toBe(false);
  });

  test("cancel(operation) aborts every job still running for it", async () => {
    const jobs = new JobTracker();
    const first = untilAborted(jobs, "resume", "resume:op_2");
    const second = untilAborted(jobs, "rollback", "rollback:op_2");
    first.operationId = "op_2";
    second.operationId = "op_2";

    expect(jobs.cancel("op_2")).toBe(true);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
  });

  test("a restarted key counts as the newest job", async () => {
    const jobs = new JobTracker();
    const apply = jobs.start("apply", "plan_3", async () => "done");
    apply.operationId = "op_3";
    await jobs.wait(apply, 5_000);
    const resume = jobs.start("resume", "resume:op_3", async () => "done");
    resume.operationId = "op_3";
    await jobs.wait(resume, 5_000);
    const again = jobs.start("apply", "plan_3", async () => "already applied");
    again.operationId = "op_3";
    await jobs.wait(again, 5_000);

    expect(jobs.find("op_3")).toBe(again);
    expect(jobs.find("plan_3")).toBe(again);
  });
});
