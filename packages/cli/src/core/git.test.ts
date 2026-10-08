/**
 * Read-only git probes: they must not run commands a repository's own
 * .git/config or the inherited environment configures (fsmonitor hooks,
 * external diff drivers), and the worktree fingerprint must reflect the
 * content actually on disk — also before the first commit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitState, revisionInfo } from "./git.ts";

const posix = process.platform !== "win32";

/** Each test spawns several git processes; generous under a loaded machine. */
const TIMEOUT_MS = 30_000;

/** Identity and config isolated from the machine, for fixture setup only. */
const SETUP_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: posix ? "/dev/null" : "NUL",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function setupGit(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: SETUP_ENV, stdin: "ignore" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "groot-git-")));
}

/** A repository with one committed file. */
function committedRepo(): string {
  const repo = scratch();
  setupGit(repo, "init", "-q");
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  setupGit(repo, "add", "-A");
  setupGit(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** An executable hook that records each run in `marker` (and prints nothing). */
function recordingHook(dir: string, name: string): { path: string; marker: string } {
  const path = join(dir, `${name}.sh`);
  const marker = join(dir, `${name}.ran`);
  writeFileSync(path, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

const INJECTED = [
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
];
const saved = new Map(INJECTED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.skipIf(!posix)("git probes run no repository-configured commands", () => {
  test(
    "a core.fsmonitor hook in .git/config does not run",
    async () => {
      // Arrange
      const repo = committedRepo();
      const hook = recordingHook(scratch(), "fsmonitor");
      setupGit(repo, "config", "core.fsmonitor", hook.path);
      writeFileSync(join(repo, "tracked.txt"), "two\n");

      // Act
      const state = await gitState(repo);
      const revision = await revisionInfo(repo);

      // Assert
      expect(state.unstaged).toEqual(["tracked.txt"]);
      expect(revision.dirty).toBe(true);
      expect(existsSync(hook.marker)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a diff.external driver in .git/config does not run",
    async () => {
      // Arrange
      const repo = committedRepo();
      const hook = recordingHook(scratch(), "extdiff");
      setupGit(repo, "config", "diff.external", hook.path);
      writeFileSync(join(repo, "tracked.txt"), "two\n");

      // Act
      const revision = await revisionInfo(repo);

      // Assert
      expect(revision.worktreeFingerprint).not.toBeNull();
      expect(existsSync(hook.marker)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "GIT_EXTERNAL_DIFF and GIT_CONFIG_* in the environment neither run nor collapse the fingerprint",
    async () => {
      // Arrange
      const repo = committedRepo();
      const tools = scratch();
      const extDiff = recordingHook(tools, "env-extdiff");
      const fsmonitor = recordingHook(tools, "env-fsmonitor");
      process.env.GIT_EXTERNAL_DIFF = extDiff.path;
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
      process.env.GIT_CONFIG_VALUE_0 = fsmonitor.path;

      // Act
      writeFileSync(join(repo, "tracked.txt"), "two\n");
      const two = (await revisionInfo(repo)).worktreeFingerprint;
      writeFileSync(join(repo, "tracked.txt"), "three\n");
      const three = (await revisionInfo(repo)).worktreeFingerprint;

      // Assert
      expect(two).not.toBeNull();
      expect(two).not.toBe(three);
      expect(existsSync(extDiff.marker)).toBe(false);
      expect(existsSync(fsmonitor.marker)).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe("worktree fingerprint", () => {
  test(
    "before the first commit it reflects working-tree content, not just the index",
    async () => {
      // Arrange: staged once, then edited (groot init leaves this state without a git identity).
      const repo = scratch();
      setupGit(repo, "init", "-q");
      writeFileSync(join(repo, "app.ts"), "one\n");
      setupGit(repo, "add", "-A");

      // Act
      writeFileSync(join(repo, "app.ts"), "two\n");
      const two = await gitState(repo);
      writeFileSync(join(repo, "app.ts"), "three\n");
      const three = await gitState(repo);

      // Assert
      expect(two.head).toBeNull();
      expect(two.worktreeFingerprint).not.toBeNull();
      expect(two.worktreeFingerprint).not.toBe(three.worktreeFingerprint);
    },
    TIMEOUT_MS,
  );

  test(
    "with commits, different dirty contents give different fingerprints",
    async () => {
      // Arrange
      const repo = committedRepo();

      // Act
      writeFileSync(join(repo, "tracked.txt"), "two\n");
      const two = (await gitState(repo)).worktreeFingerprint;
      writeFileSync(join(repo, "tracked.txt"), "three\n");
      const three = (await gitState(repo)).worktreeFingerprint;
      writeFileSync(join(repo, "tracked.txt"), "one\n");
      const clean = await gitState(repo);

      // Assert
      expect(two).not.toBe(three);
      expect(clean.dirty).toBe(false);
      expect(clean.worktreeFingerprint).toBeNull();
    },
    TIMEOUT_MS,
  );
});
