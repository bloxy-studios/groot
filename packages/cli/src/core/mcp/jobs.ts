/**
 * Background jobs for the MCP server. MCP clients time out long calls (Codex
 * after 60–300 s, without sending a cancel), so long operations run in the
 * server process and each tool call waits at most a bounded time. The
 * authoritative state is the executor's on-disk journal — a client that
 * reconnects, or the CLI, can always recover it with `operation_status` /
 * `groot status`. Cancelling a wait never cancels the operation; only
 * `operation_cancel` does.
 */

export const DEFAULT_WAIT_MS = 20_000;
export const MAX_WAIT_MS = 45_000;

export interface Job<T> {
  readonly key: string;
  readonly kind: string;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  readonly startedAt: number;
  done: boolean;
  result: T | undefined;
  error: unknown;
  /** Set once known (the executor assigns it when the operation starts). */
  operationId: string | null;
}

export function clampWait(waitMs: number | undefined): number {
  if (waitMs === undefined) return DEFAULT_WAIT_MS;
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.round(waitMs)));
}

export class JobTracker {
  private readonly jobs = new Map<string, Job<unknown>>();

  start<T>(kind: string, key: string, run: (signal: AbortSignal) => Promise<T>): Job<T> {
    const existing = this.jobs.get(key) as Job<T> | undefined;
    if (existing !== undefined && !existing.done) return existing;
    const controller = new AbortController();
    const job: Job<T> = {
      key,
      kind,
      controller,
      startedAt: Date.now(),
      done: false,
      result: undefined,
      error: undefined,
      operationId: null,
      promise: Promise.resolve().then(() => run(controller.signal)),
    };
    job.promise.then(
      (result) => {
        job.done = true;
        job.result = result;
      },
      (error: unknown) => {
        job.done = true;
        job.error = error;
      },
    );
    // Re-insert so iteration order stays start order (a restarted key is the newest).
    this.jobs.delete(key);
    this.jobs.set(key, job as Job<unknown>);
    return job;
  }

  /**
   * Find a job by its key, or by the operation it was linked to: the newest
   * job still running for that operation (a resume or rollback outlives the
   * apply that started it), else the newest one.
   */
  find(keyOrOperationId: string): Job<unknown> | undefined {
    const direct = this.jobs.get(keyOrOperationId);
    if (direct !== undefined) return direct;
    const linked = this.linkedTo(keyOrOperationId);
    return linked.findLast((job) => !job.done) ?? linked.at(-1);
  }

  private linkedTo(operationId: string): Job<unknown>[] {
    return [...this.jobs.values()].filter((job) => job.operationId === operationId);
  }

  /**
   * Wait until the job settles, `waitMs` elapses, or the caller's request is
   * cancelled (which ends only the wait). Returns whether it settled.
   */
  async wait(job: Job<unknown>, waitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (job.done) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const settled = job.promise.then(
      () => true,
      () => true,
    );
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      if (signal !== undefined) {
        onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const outcome = await Promise.race([settled, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    return outcome;
  }

  /**
   * Cooperatively cancel a running job — or every job still running for an
   * operation (the executor checkpoints and stops). False when none ran.
   */
  cancel(keyOrOperationId: string): boolean {
    const direct = this.jobs.get(keyOrOperationId);
    const running = (direct !== undefined ? [direct] : this.linkedTo(keyOrOperationId)).filter(
      (job) => !job.done,
    );
    for (const job of running) job.controller.abort("cancelled via operation_cancel");
    return running.length > 0;
  }

  /** Abort everything (server shutdown). */
  abortAll(reason: string): void {
    for (const job of this.jobs.values()) {
      if (!job.done) job.controller.abort(reason);
    }
  }

  running(): Job<unknown>[] {
    return [...this.jobs.values()].filter((job) => !job.done);
  }
}
