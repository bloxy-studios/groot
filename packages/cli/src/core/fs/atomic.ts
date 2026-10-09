/**
 * Crash-safe file primitives. `writeFileAtomic` writes a temp file in the same
 * directory, fsyncs it, renames over the target, then fsyncs the directory —
 * a reader (or a crash) sees the old content or the new, never a torn file.
 * Unless a mode is given, a replaced file keeps its permissions (a 0600
 * secrets file stays 0600, a script keeps its execute bits).
 * `appendLineDurable` is the journal's checkpoint primitive: one write of a
 * complete line followed by fsync, so a crash can at worst lose the line being
 * written (detected and ignored as a torn tail on replay). It never appends
 * through a symlink.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { GrootV2Error } from "../errors.ts";

const isPosix = process.platform !== "win32";

const DEFAULT_MODE = 0o644;

/** O_NOFOLLOW is not defined on Windows. */
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

function fsyncDir(dir: string): void {
  // Directory fsync persists the rename; unsupported on some platforms (Windows) — best effort.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // ignore: platform without directory fsync
  }
}

/** Permission bits of an existing file (setuid/setgid are not carried over), or null. */
function existingPermissions(path: string): number | null {
  if (!isPosix) return null;
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Replace `absPath` atomically. `mode` sets its permissions exactly; without
 * it a replaced file keeps its own, and a new file gets 0644 minus the umask.
 */
export function writeFileAtomic(
  absPath: string,
  content: string | Uint8Array,
  mode?: number,
): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const exact = mode ?? existingPermissions(absPath);
  const temp = join(dir, `.${basename(absPath)}.groot-tmp-${randomBytes(4).toString("hex")}`);
  const fd = openSync(temp, "w", exact ?? DEFAULT_MODE);
  try {
    // Set before any content is written, and after open so the umask cannot interfere.
    if (exact !== null && isPosix) fchmodSync(fd, exact);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, absPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

export function appendLineDurable(absPath: string, line: string): void {
  if (line.includes("\n")) {
    throw new Error("appendLineDurable: a journal line must not contain newlines");
  }
  mkdirSync(dirname(absPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(absPath, APPEND_FLAGS, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    throw new GrootV2Error(
      "GROOT_E_PATH_OUTSIDE_PROJECT",
      `Refusing to append to "${absPath}": it is a symlink.`,
      {
        hint: "Groot only appends to regular files it created; remove the symlink and retry.",
        details: { path: absPath },
      },
    );
  }
  try {
    const bytes = Buffer.from(`${line}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
