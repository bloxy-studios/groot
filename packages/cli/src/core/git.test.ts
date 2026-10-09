/**
 * Read-only git probes: they must not run commands a repository's own
 * .git/config or the inherited environment configures (fsmonitor hooks,
 * external diff drivers, repository hooks), must not write the index, and
 * the worktree fingerprint must reflect the content actually on disk — also
 * before the first commit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_TIMED_OUT, git, gitState, revisionInfo } from "./git.ts";

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

/**
 * A committed repository whose tracked files are stat-dirty (touched, same
 * content) beside one real edit — the state in which `git diff` refreshes
 * and rewrites the index unless told not to.
 */
function statDirtyRepo(): string {
  const repo = committedRepo();
  for (const name of ["a.txt", "b.txt"]) writeFileSync(join(repo, name), "same\n");
  setupGit(repo, "add", "-A");
  setupGit(repo, "commit", "-q", "-m", "more");
  writeFileSync(join(repo, "tracked.txt"), "two\n");
  writeFileSync(join(repo, "untracked.txt"), "new\n");
  const later = new Date(Date.now() + 60_000);
  for (const name of ["a.txt", "b.txt"]) utimesSync(join(repo, name), later, later);
  return repo;
}

const INJECTED = [
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CEILING_DIRECTORIES",
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

  test(
    "a post-index-change hook in .git/hooks does not run and the index is not rewritten",
    async () => {
      // Arrange: the hook is installed after setup, so only the probes could run it.
      const repo = statDirtyRepo();
      const hook = recordingHook(scratch(), "post-index-change");
      mkdirSync(join(repo, ".git/hooks"), { recursive: true });
      writeFileSync(join(repo, ".git/hooks/post-index-change"), readFileSync(hook.path, "utf8"));
      chmodSync(join(repo, ".git/hooks/post-index-change"), 0o755);
      const indexBefore = readFileSync(join(repo, ".git/index"));

      // Act
      const state = await gitState(repo);
      const revision = await revisionInfo(repo);

      // Assert
      expect(state.unstaged).toEqual(["tracked.txt"]);
      expect(revision.worktreeFingerprint).not.toBeNull();
      expect(existsSync(hook.marker)).toBe(false);
      expect(readFileSync(join(repo, ".git/index")).equals(indexBefore)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "a hook in a repository-configured core.hooksPath directory does not run",
    async () => {
      // Arrange: what a repository with a shared hooks directory looks like after setup.
      const repo = statDirtyRepo();
      const hook = recordingHook(scratch(), "shared-hook");
      mkdirSync(join(repo, ".githooks"));
      writeFileSync(join(repo, ".githooks/post-index-change"), readFileSync(hook.path, "utf8"));
      chmodSync(join(repo, ".githooks/post-index-change"), 0o755);
      setupGit(repo, "config", "core.hooksPath", ".githooks");

      // Act
      await revisionInfo(repo);

      // Assert
      expect(existsSync(hook.marker)).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!posix)("git probes keep discovery-only settings", () => {
  test(
    "GIT_CEILING_DIRECTORIES still stops discovery at the ceiling",
    async () => {
      // Arrange: a project without .git below a repository the user fenced off.
      const parent = scratch();
      setupGit(parent, "init", "-q");
      const project = join(parent, "project");
      mkdirSync(project);
      writeFileSync(join(project, "app.ts"), "export {};\n");
      process.env.GIT_CEILING_DIRECTORIES = parent;

      // Act
      const state = await gitState(project);

      // Assert
      expect(state.vcs).toBe("none");
      expect(state.untracked).toEqual([]);
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

describe.skipIf(!posix)("git probes are bounded in time", () => {
  test(
    "a clean filter that hangs is killed with its process group at the timeout",
    async () => {
      // Arrange — the repository's own .git/config assigns a filter that never
      // returns (flags can't disable filter drivers; a timeout bounds them).
      const repo = committedRepo();
      const marker = join(scratch(), "filter-pid");
      setupGit(repo, "config", "filter.hang.clean", `sh -c 'echo $$ > ${marker}; sleep 60'`);
      writeFileSync(join(repo, ".gitattributes"), "*.txt filter=hang\n");
      // Same size as the committed content, so only hashing it (through the
      // filter) can tell whether it changed.
      writeFileSync(join(repo, "tracked.txt"), "two\n");
      const started = Date.now();

      // Act
      const result = await git(repo, ["status", "--porcelain=v1"], 1500);

      // Assert — bounded, reported as a timeout, and nothing left running.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.exitCode).toBe(GIT_TIMED_OUT);
      expect(result.stderr).toContain("timed out");
      if (existsSync(marker)) {
        const pid = Number(readFileSync(marker, "utf8").trim());
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    },
    TIMEOUT_MS,
  );
});
