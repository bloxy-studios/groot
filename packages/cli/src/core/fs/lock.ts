/**
 * Project writer coordination. Every mutating operation (apply, resume,
 * rollback, context sync, task integration) holds `.groot/lock.json`. The lock
 * appears together with its holder record — a fully written temp file is
 * hard-linked into place, which fails with EEXIST while it is held — so
 * exactly one writer wins and no reader ever sees a lock without its holder
 * (O_CREAT|O_EXCL + write is the fallback where hard links are unsupported).
 * A lock left by a dead process on this host is taken over (serialized
 * through a short-lived takeover mutex so two recoverers can't both win); a
 * live holder — or one on another host that can't be checked — yields
 * GROOT_E_LOCKED with its details. An unreadable lock is never deleted on
 * sight: it counts as held until it is older than the grace period.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
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

/**
 * A takeover mutex — or an unreadable lock — older than this was left by a
 * writer that crashed mid-takeover or mid-create.
 */
const TAKEOVER_STALE_MS = 10_000;

/** link(2) errors meaning the filesystem has no hard links (FAT/exFAT, some network mounts). */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);

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

/** O_CREAT|O_EXCL, write, fsync; the file is removed again if the write fails. */
function writeExclusive(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
}

/** Exclusive create of the lock itself (the no-hard-link fallback); false when held. */
function createExclusive(path: string, content: string): boolean {
  try {
    writeExclusive(path, content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function tryCreate(lockPath: string, holder: LockHolder): boolean {
  const content = `${JSON.stringify(holder)}\n`;
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeExclusive(temp, content);
  try {
    linkSync(temp, lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (NO_HARD_LINKS.has(code)) return createExclusive(lockPath, content);
    throw error;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort: a stray temp file is harmless; losing an acquired lock is not
    }
  }
}

/** The lock's holder, "missing" (no lock), or "unreadable" (empty, torn, or foreign). */
function readLock(path: string): LockHolder | "missing" | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    return LockHolder.parse(JSON.parse(text));
  } catch {
    return "unreadable";
  }
}

function readHolder(path: string): LockHolder | null {
  const lock = readLock(path);
  return typeof lock === "string" ? null : lock;
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return a.pid === b.pid && a.host === b.host && a.acquiredAt === b.acquiredAt;
}

/** Run `recover` holding the takeover mutex; false when another process is recovering. */
function withTakeoverMutex(lockPath: string, recover: () => boolean): boolean {
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
    return recover();
  } finally {
    rmSync(mutex, { force: true });
  }
}

/** Remove a provably stale lock, serialized through the takeover mutex. */
function takeOverStale(lockPath: string, stale: LockHolder): boolean {
  return withTakeoverMutex(lockPath, () => {
    const current = readHolder(lockPath);
    if (current !== null && sameHolder(current, stale)) {
      rmSync(lockPath, { force: true });
      return true;
    }
    return current === null;
  });
}

/**
 * Remove an unreadable lock once it is older than the grace period, under the
 * takeover mutex and only if it is still the same unreadable file. True when
 * the caller should retry its create; false while the lock counts as held.
 */
function removeTornLock(lockPath: string): boolean {
  const seen = statOrNull(lockPath);
  if (seen === null) return true; // released meanwhile
  if (Date.now() - seen.mtimeMs <= TAKEOVER_STALE_MS) return false;
  return withTakeoverMutex(lockPath, () => {
    const current = statOrNull(lockPath);
    if (
      current?.isFile() &&
      current.ino === seen.ino &&
      current.mtimeMs === seen.mtimeMs &&
      readLock(lockPath) === "unreadable"
    ) {
      rmSync(lockPath, { force: true });
    }
    return true; // removed, or replaced since: look again
  });
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
    const existing = readLock(lockPath);
    // Released since our create failed: try again — never delete what we did not read.
    if (existing === "missing") continue;
    if (existing === "unreadable") {
      // A writer between its exclusive create and its write (the no-hard-link
      // fallback), or one that crashed there: held until the grace period ends.
      if (removeTornLock(lockPath)) continue;
      throw new GrootV2Error(
        "GROOT_E_LOCKED",
        "The project lock is unreadable — another groot process may be creating it.",
        {
          hint: `Retry in a moment. An unreadable lock is recovered automatically once it is older than ${TAKEOVER_STALE_MS / 1000} s.`,
          details: { lockPath },
        },
      );
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
