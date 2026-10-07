/**
 * Project writer coordination. Every mutating operation (apply, resume,
 * rollback, context sync, task integration) holds `.groot/lock.json`, created
 * with O_CREAT|O_EXCL so exactly one writer wins. A lock left by a dead
 * process on this host is taken over (serialized through a short-lived
 * takeover mutex so two recoverers can't both win); a live holder — or one on
 * another host that can't be checked — yields GROOT_E_LOCKED with its details.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GrootV2Error } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { ensureStateDir } from "../state.ts";

const LockHolder = z
  .object({
    pid: z.number().int(),
    host: z.string(),
    command: z.string(),
    operationId: z.string().nullable(),
    acquiredAt: z.string(),
  })
  .strict();
export type LockHolder = z.infer<typeof LockHolder>;

/** A takeover mutex older than this is itself stale (its holder crashed mid-takeover). */
const TAKEOVER_STALE_MS = 10_000;

export interface ProjectLock {
  readonly holder: LockHolder;
  /** Previous holder whose stale lock was taken over, if any. */
  readonly tookOverFrom: LockHolder | null;
  release(): void;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(path: string, holder: LockHolder): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readHolder(path: string): LockHolder | null {
  try {
    return LockHolder.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return a.pid === b.pid && a.host === b.host && a.acquiredAt === b.acquiredAt;
}

/** Remove a provably stale lock, serialized through the takeover mutex. */
function takeOverStale(lockPath: string, stale: LockHolder): boolean {
  const mutex = `${lockPath}.takeover`;
  try {
    const age = Date.now() - statSync(mutex).mtimeMs;
    if (age > TAKEOVER_STALE_MS) rmSync(mutex, { force: true });
  } catch {
    // no mutex present
  }
  let fd: number;
  try {
    fd = openSync(mutex, "wx", 0o644);
  } catch {
    return false; // another process is recovering — caller retries/reports
  }
  closeSync(fd);
  try {
    const current = readHolder(lockPath);
    if (current !== null && sameHolder(current, stale)) {
      rmSync(lockPath, { force: true });
      return true;
    }
    return current === null;
  } finally {
    rmSync(mutex, { force: true });
  }
}

export function acquireProjectLock(
  root: string,
  info: { command: string; operationId: string | null },
): ProjectLock {
  const stateDir = ensureStateDir(root);
  const lockPath = join(stateDir, "lock.json");
  const holder: LockHolder = {
    pid: process.pid,
    host: hostname(),
    command: info.command,
    operationId: info.operationId,
    acquiredAt: nowIso(),
  };
  let tookOverFrom: LockHolder | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockPath, holder)) {
      return {
        holder,
        tookOverFrom,
        release(): void {
          const current = readHolder(lockPath);
          if (current !== null && sameHolder(current, holder)) rmSync(lockPath, { force: true });
        },
      };
    }
    const existing = readHolder(lockPath);
    if (existing === null) {
      // Unreadable/torn lock file: only a crashed writer leaves that behind.
      rmSync(lockPath, { force: true });
      continue;
    }
    const sameHost = existing.host === hostname();
    if (sameHost && !isProcessAlive(existing.pid) && takeOverStale(lockPath, existing)) {
      tookOverFrom = existing;
      continue;
    }
    throw new GrootV2Error(
      "GROOT_E_LOCKED",
      `Another groot process is changing this project (${existing.command}, pid ${existing.pid}${sameHost ? "" : ` on ${existing.host}`}).`,
      {
        hint: sameHost
          ? "Wait for it to finish, or check `groot status`. Locks from crashed processes are recovered automatically."
          : `The lock was taken on another host; if that process is gone, delete ${lockPath}.`,
        details: { holder: existing, lockPath },
      },
    );
  }
  throw new GrootV2Error("GROOT_E_LOCKED", "Could not acquire the project lock.", {
    details: { lockPath },
  });
}
