/**
 * The worktree fingerprint's untracked paths: it stays inside the project and
 * bounded. A symlink counts by its link text — what it points to (outside the
 * project, a FIFO, a device) is never opened — and a file above the size cap
 * counts by its size and mtime instead of being read.
 */
import { describe, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  openSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GitState } from "./contracts/project.ts";
import { initRepo, makeProject } from "./discovery/test-projects.ts";
import { gitState } from "./git.ts";

const posix = process.platform !== "win32";

/** Each test runs several git processes; generous under a loaded machine. */
const TIMEOUT_MS = 60_000;

/** Far above a normal probe; only a fingerprint stuck on a FIFO gets near it. */
const DEADLINE_MS = 20_000;
const DEADLINE = Symbol("deadline");

/** A repository with one committed file. */
async function committedRepo(): Promise<string> {
  const repo = makeProject({ "tracked.txt": "one\n" }, "groot-fingerprint-");
  await initRepo(repo);
  return repo;
}

async function fingerprint(repo: string): Promise<string | null> {
  return (await gitState(repo)).worktreeFingerprint;
}

/** gitState, or DEADLINE if it has not returned after `ms` (a read stuck on a FIFO never does). */
async function gitStateWithin(repo: string, ms: number): Promise<GitState | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms);
  });
  try {
    return await Promise.race([gitState(repo), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether anything holds `fifo` open for reading. Opening the write end
 * without blocking succeeds only then (ENXIO otherwise); closing it at once
 * gives such a reader end-of-file, so it stops waiting.
 */
function releaseReader(fifo: string): boolean {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
}

describe("worktree fingerprint — untracked paths", () => {
  test(
    "an untracked symlink counts by its link text, never by the file it points to",
    async () => {
      // Arrange: a link to a file outside the project.
      const repo = await committedRepo();
      const outside = makeProject({ "a.txt": "one\n", "b.txt": "one\n" }, "groot-outside-");
      symlinkSync(join(outside, "a.txt"), join(repo, "link"));

      // Act
      const before = await fingerprint(repo);
      writeFileSync(join(outside, "a.txt"), "edited outside the project\n");
      const targetEdited = await fingerprint(repo);
      unlinkSync(join(repo, "link"));
      symlinkSync(join(outside, "b.txt"), join(repo, "link"));
      const relinked = await fingerprint(repo);

      // Assert
      expect(before).not.toBeNull();
      expect(targetEdited).toBe(before);
      expect(relinked).not.toBe(before);
    },
    TIMEOUT_MS,
  );

  test.skipIf(!posix)(
    "an untracked symlink to a FIFO outside the project neither blocks nor opens it",
    async () => {
      // Arrange
      const repo = await committedRepo();
      const fifo = join(makeProject({}, "groot-outside-"), "pipe");
      const made = Bun.spawnSync(["mkfifo", fifo], { stdin: "ignore" });
      if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
      symlinkSync(fifo, join(repo, "link-to-fifo"));

      // Act
      const state = await gitStateWithin(repo, DEADLINE_MS);
      const opened = releaseReader(fifo);

      // Assert
      expect(state).not.toBe(DEADLINE);
      expect(opened).toBe(false);
      const { untracked, worktreeFingerprint } = state as GitState;
      expect(untracked).toEqual(["link-to-fifo"]);
      expect(worktreeFingerprint).not.toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "an untracked regular file counts by its content",
    async () => {
      // Arrange
      const repo = await committedRepo();
      writeFileSync(join(repo, "notes.txt"), "first\n");

      // Act
      const before = await fingerprint(repo);
      const again = await fingerprint(repo);
      writeFileSync(join(repo, "notes.txt"), "other\n");
      const edited = await fingerprint(repo);

      // Assert
      expect(again).toBe(before);
      expect(edited).not.toBe(before);
    },
    TIMEOUT_MS,
  );

  test(
    "an untracked file above the size cap counts by its size and mtime, without being read",
    async () => {
      // Arrange
      const repo = await committedRepo();
      const big = join(repo, "big.bin");
      const size = 3 * 1024 * 1024;
      const first = new Date("2026-01-01T00:00:00Z");
      writeFileSync(big, Buffer.alloc(size, 1));
      utimesSync(big, first, first);

      // Act
      const before = await fingerprint(repo);
      writeFileSync(big, Buffer.alloc(size, 2));
      utimesSync(big, first, first);
      const sameSizeAndTime = await fingerprint(repo);
      const later = new Date("2026-01-02T00:00:00Z");
      utimesSync(big, later, later);
      const touched = await fingerprint(repo);

      // Assert: the content is not read above the cap; a write that moves the mtime still counts.
      expect(sameSizeAndTime).toBe(before);
      expect(touched).not.toBe(before);
    },
    TIMEOUT_MS,
  );
});
