/**
 * Crash-safe file primitives. `writeFileAtomic` writes a temp file in the same
 * directory, fsyncs it, renames over the target, then fsyncs the directory —
 * a reader (or a crash) sees the old content or the new, never a torn file.
 * `appendLineDurable` is the journal's checkpoint primitive: one write of a
 * complete line followed by fsync, so a crash can at worst lose the line being
 * written (detected and ignored as a torn tail on replay).
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

export function writeFileAtomic(absPath: string, content: string | Uint8Array, mode = 0o644): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(absPath)}.groot-tmp-${randomBytes(4).toString("hex")}`);
  const fd = openSync(temp, "w", mode);
  try {
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
  const fd = openSync(absPath, "a", 0o644);
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
