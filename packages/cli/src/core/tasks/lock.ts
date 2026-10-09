/**
 * Short critical sections under the project writer lock (.groot/lock.json):
 * claiming a task (overlap check + worktree creation + status), recording a
 * review decision, and the whole integration. The file lock refuses a second
 * holder even in the SAME process (parallel task runs), so callers in one
 * process are serialized first; a lock held by another process is waited
 * for, briefly, before GROOT_E_LOCKED surfaces. `tryWithProjectLock` waits
 * at most its budget for both and reports "busy" instead of failing — for
 * writes that may be skipped (a view-only review).
 */
import { GrootV2Error } from "../errors.ts";
import { acquireProjectLock } from "../fs/lock.ts";

const chains = new Map<string, Promise<void>>();
const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 150;

async function acquireWithWait(root: string, command: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireProjectLock(root, { command, operationId: null });
    } catch (error) {
      const locked = error instanceof GrootV2Error && error.id === "GROOT_E_LOCKED";
      if (!locked || Date.now() >= deadline) throw error;
      await Bun.sleep(POLL_MS);
    }
  }
}

/** Join this process's queue for `root`: resolves once earlier callers are done. */
function enqueue(root: string): { ready: Promise<void>; done: () => void } {
  const previous = chains.get(root) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  chains.set(root, tail);
  return {
    ready: previous,
    done: () => {
      release();
      if (chains.get(root) === tail) chains.delete(root);
    },
  };
}

/** Run `fn` while holding the project lock (see the module comment). */
export async function withProjectLock<T>(
  root: string,
  command: string,
  fn: () => Promise<T>,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T> {
  const turn = enqueue(root);
  await turn.ready;
  try {
    const lock = await acquireWithWait(root, command, waitMs);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  } finally {
    turn.done();
  }
}

/** Resolve true when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return settled;
}

export type TryLock<T> =
  | { readonly held: true; readonly value: T }
  | { readonly held: false; readonly reason: string };

/**
 * Run `fn` under the project lock if it can be had within `waitMs` (this
 * process's queue and another process's lock alike); otherwise do nothing
 * and say who holds it.
 */
export async function tryWithProjectLock<T>(
  root: string,
  command: string,
  fn: () => Promise<T>,
  waitMs: number,
): Promise<TryLock<T>> {
  const deadline = Date.now() + waitMs;
  for (let queued = chains.get(root); queued !== undefined; queued = chains.get(root)) {
    if (!(await settlesWithin(queued, deadline - Date.now()))) {
      return {
        held: false,
        reason: "another task operation in this process holds the project lock",
      };
    }
  }
  const turn = enqueue(root); // the queue is empty: no wait
  try {
    let lock: ReturnType<typeof acquireProjectLock>;
    try {
      lock = await acquireWithWait(root, command, Math.max(0, deadline - Date.now()));
    } catch (error) {
      if (error instanceof GrootV2Error && error.id === "GROOT_E_LOCKED") {
        return { held: false, reason: error.message };
      }
      throw error;
    }
    try {
      return { held: true, value: await fn() };
    } finally {
      lock.release();
    }
  } finally {
    turn.done();
  }
}
