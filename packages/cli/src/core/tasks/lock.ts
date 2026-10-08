/**
 * Short critical sections under the project writer lock (.groot/lock.json):
 * claiming a task (overlap check + worktree creation + status), and the whole
 * integration. The file lock refuses a second holder even in the SAME
 * process (parallel task runs), so callers in one process are serialized
 * first; a lock held by another process is waited for, briefly, before
 * GROOT_E_LOCKED surfaces.
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

/** Run `fn` while holding the project lock (see the module comment). */
export async function withProjectLock<T>(
  root: string,
  command: string,
  fn: () => Promise<T>,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  chains.set(root, tail);
  await previous;
  try {
    const lock = await acquireWithWait(root, command, waitMs);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  } finally {
    release();
    if (chains.get(root) === tail) chains.delete(root);
  }
}
