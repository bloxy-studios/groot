import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCreateCommand, gitIdentityPresent, publishToGitHub } from "./github.ts";

/**
 * Hermetic gh: a shim script on a controlled PATH whose behavior is driven by
 * FAKE_GH_* env vars, logging every invocation — no network, no real gh, no
 * inherited auth state.
 */
async function fakeGh(behavior: {
  authExit?: number;
  createExit?: number;
  createStdout?: string;
  createStderr?: string;
}): Promise<{ PATH: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), "groot-fake-gh-"));
  const log = join(dir, "invocations.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> "${log}"`,
    'case "$1" in',
    `  auth) exit ${behavior.authExit ?? 0} ;;`,
    "  repo)",
    ...(behavior.createStdout === undefined ? [] : [`    echo "${behavior.createStdout}"`]),
    ...(behavior.createStderr === undefined ? [] : [`    echo "${behavior.createStderr}" >&2`]),
    `    exit ${behavior.createExit ?? 0} ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(join(dir, "gh"), script, "utf8");
  await chmod(join(dir, "gh"), 0o755);
  return { PATH: dir, log };
}

async function scratchRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "groot-gh-target-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("publishToGitHub (issue #44 — degrade, never fail)", () => {
  test("gh missing from PATH → gh-missing with install + manual fallback", async () => {
    const empty = await mkdtemp(join(tmpdir(), "groot-empty-path-"));
    const result = await publishToGitHub({
      name: "demo",
      targetDir: await scratchRepoDir(),
      visibility: "private",
      env: { PATH: empty },
    });
    expect(result.status).toBe("gh-missing");
    expect(result.fallback.join("\n")).toContain("https://cli.github.com");
    expect(result.fallback.join("\n")).toContain(
      "gh repo create demo --private --source=. --remote=origin --push",
    );
  });

  test("gh unauthenticated (auth status exit 1 — verified on 2.96.0) → login fallback", async () => {
    const { PATH } = await fakeGh({ authExit: 1 });
    const result = await publishToGitHub({
      name: "demo",
      targetDir: await scratchRepoDir(),
      visibility: "private",
      env: { PATH },
    });
    expect(result.status).toBe("gh-unauthenticated");
    expect(result.fallback[0]).toBe("gh auth login");
  });

  test("authenticated create → created, URL from gh's non-TTY stdout, exact argv", async () => {
    const { PATH, log } = await fakeGh({
      createStdout: "https://github.com/tester/demo",
      createExit: 0,
    });
    const targetDir = await scratchRepoDir();
    const result = await publishToGitHub({
      name: "demo",
      targetDir,
      visibility: "public",
      env: { PATH },
    });
    expect(result.status).toBe("created");
    expect(result.url).toBe("https://github.com/tester/demo");
    expect(result.fallback).toEqual([]);
    // The invocation contract — verified flag set from the published gh
    // sources: exactly one visibility flag, --source, --remote, --push.
    const invocations = (await readFile(log, "utf8")).trim().split("\n");
    expect(invocations[0]).toBe("auth status");
    expect(invocations[1]).toBe("repo create demo --public --source=. --remote=origin --push");
  });

  test("create failure (gh exits 4 on auth errors) → failed with stderr reason + manual step", async () => {
    const { PATH } = await fakeGh({
      createExit: 4,
      createStderr: "To get started with GitHub CLI, please run:  gh auth login",
    });
    const result = await publishToGitHub({
      name: "demo",
      targetDir: await scratchRepoDir(),
      visibility: "private",
      env: { PATH },
    });
    expect(result.status).toBe("failed");
    expect(result.note).toContain("exit 4");
    expect(result.note).toContain("To get started with GitHub CLI");
    expect(result.fallback).toEqual([ghCreateCommand("demo", "private")]);
  });

  test("unauthenticated short-circuits — repo create is never attempted", async () => {
    const { PATH, log } = await fakeGh({ authExit: 1 });
    await publishToGitHub({
      name: "demo",
      targetDir: await scratchRepoDir(),
      visibility: "private",
      env: { PATH },
    });
    const invocations = (await readFile(log, "utf8")).trim().split("\n");
    expect(invocations).toEqual(["auth status"]);
  });
});

describe("gitIdentityPresent (the --github ordering fix)", () => {
  test("false with no identity anywhere; true once both halves exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "groot-gh-home-"));
    const cwd = await scratchRepoDir();
    // Isolate from the runner's real config: fresh HOME, no system config.
    const bare = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    expect(await gitIdentityPresent(cwd, bare)).toBe(false);

    await writeFile(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test Groot\n\temail = groot@example.com\n",
      "utf8",
    );
    expect(await gitIdentityPresent(cwd, bare)).toBe(true);
  });

  test("false when only one half is configured (the commit needs both)", async () => {
    const home = await mkdtemp(join(tmpdir(), "groot-gh-home-"));
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Only Name\n", "utf8");
    expect(
      await gitIdentityPresent(await scratchRepoDir(), {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      }),
    ).toBe(false);
  });
});
