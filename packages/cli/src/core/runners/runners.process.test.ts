/**
 * Runner adapters against SIMULATED agents (fake `claude`/`codex` Bun
 * executables pointed at via GROOT_CLAUDE_PATH / GROOT_CODEX_PATH): real
 * processes, real signals, real process groups — no model is ever called.
 * Covers argv/env/stdin as the agent actually receives them, wall-time
 * timeouts, cancellation with no surviving group members, SIGTERM
 * escalation, resume argv, and discovery classification.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCapabilities } from "../contracts/task.ts";
import { killTree } from "../process.ts";
import { discoverRunners, getRunner } from "./index.ts";
import { groupMembers, inspectRunnerGroup, stopRunnerGroup } from "./supervise.ts";
import { type FakeAgents, type FakeScenario, installFakeAgents } from "./testing/fake-agents.ts";
import type { RunnerHandle, RunnerInvocation } from "./types.ts";

const TIMEOUT = 90_000;
const SESSION = "6f1e2d3c-4b5a-4987-8765-43210fedcba9";
const TOKEN = "tok-abcdef1234567890";
const HOST = join(import.meta.dir, "testing/runner-host.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Remove the fakes' temp root after the file's tests. */
function tracked(fakes: FakeAgents): FakeAgents {
  scratch.push(fakes.root);
  return fakes;
}

function setup(scenario: FakeScenario): { fakes: FakeAgents; cwd: string } {
  const fakes = tracked(installFakeAgents());
  fakes.scenario(scenario);
  const cwd = mkdtempSync(join(tmpdir(), "groot-runner-cwd-"));
  scratch.push(cwd);
  return { fakes, cwd };
}

/** True once no process of the group is left (polled; the kernel reaps asynchronously). */
async function groupGone(pgid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await groupMembers(pgid)).length === 0) return true;
    await Bun.sleep(100);
  }
  return (await groupMembers(pgid)).length === 0;
}

interface Host {
  readonly proc: ReturnType<typeof Bun.spawn>;
  /** The first stdout line matching `pattern` (null when none arrives in time). */
  line(pattern: RegExp, ms?: number): Promise<string | null>;
}

/** Start testing/runner-host.ts (one simulated Claude run in a separate host process). */
function startHost(fakes: FakeAgents, cwd: string, extra: string[] = []): Host {
  const proc = Bun.spawn([process.execPath, HOST, cwd, join(cwd, "attempt.jsonl"), ...extra], {
    env: fakes.env(),
    stdout: "pipe",
    stderr: "ignore",
  });
  let text = "";
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      text += new TextDecoder().decode(chunk);
    }
  })();
  return {
    proc,
    async line(pattern, ms = 30_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = text.split("\n").find((entry) => pattern.test(entry));
        if (found !== undefined) return found;
        await Bun.sleep(50);
      }
      return null;
    },
  };
}

function invocation(
  fakes: FakeAgents,
  cwd: string,
  overrides: Partial<RunnerInvocation> = {},
): RunnerInvocation {
  return {
    cwd,
    prompt: "PROMPT-ON-STDIN: make it pass",
    sessionId: SESSION,
    limits: { maxTurns: 7, maxBudgetUsd: 0.5, wallTimeMs: 60_000 },
    allowedCommands: ["bun test"],
    eventsLogPath: join(cwd, "attempt-1.jsonl"),
    signal: new AbortController().signal,
    systemPrompt: "rules",
    env: fakes.env({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "outer-session",
      CLAUDE_EFFORT: "max",
      NODE_OPTIONS: "--require /tmp/preload.js",
      CMUX_SURFACE_ID: "surface",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_AUTH_TOKEN: TOKEN,
    }),
    grace: { interruptMs: 2000, terminateMs: 2000 },
    ...overrides,
  };
}

async function waitForStart(fakes: FakeAgents, count = 1): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const records = fakes.records();
    if (records.length >= count) return (records[count - 1] as { pid: number }).pid;
    await Bun.sleep(50);
  }
  throw new Error("the fake runner never started");
}

async function drain(handle: RunnerHandle): Promise<string[]> {
  const kinds: string[] = [];
  for await (const event of handle.events) kinds.push(`${event.kind}:${event.type}`);
  return kinds;
}

describe("Claude Code adapter (simulated runner)", () => {
  test(
    "the agent receives containment flags, the prompt on stdin, and a scrubbed env; secrets never reach the log",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({
        steps: [
          {
            mode: "success",
            edits: { "src/a.ts": "export const a = 1;\n" },
            message: `done ${TOKEN}`,
          },
        ],
      });

      // Act
      const handle = getRunner("claude-code").start(invocation(fakes, cwd));
      const kinds = await drain(handle);
      const result = await handle.result;

      // Assert
      expect(result).toMatchObject({
        status: "succeeded",
        sessionId: SESSION,
        exitCode: 0,
        simulated: true,
      });
      expect(result.usage.kind).toBe("observed-cost");
      expect(result.finalMessage).not.toContain(TOKEN);
      expect(kinds).toContain("session:system/init");
      expect(kinds).toContain("unknown:rate_limit_event");
      const [record] = fakes.records();
      expect(record?.stdin).toBe("PROMPT-ON-STDIN: make it pass");
      expect(record?.argv.join(" ")).not.toContain("PROMPT-ON-STDIN");
      expect(record?.argv).toEqual(
        expect.arrayContaining(["-p", "--strict-mcp-config", "--permission-prompts", "none"]),
      );
      expect(record?.argv[record.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
      for (const name of [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_EFFORT",
        "NODE_OPTIONS",
        "CMUX_SURFACE_ID",
      ]) {
        expect(record?.envNames).not.toContain(name);
      }
      expect(record?.env).toMatchObject({
        CLAUDE_CODE_USE_FOUNDRY: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        DISABLE_AUTOUPDATER: "1",
      });
      expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toContain("a = 1");
      const log = readFileSync(join(cwd, "attempt-1.jsonl"), "utf8");
      expect(log).toContain('"type":"groot.spawn"');
      expect(log).toContain('"subtype":"init"');
      expect(log).not.toContain(TOKEN);
    },
    TIMEOUT,
  );

  test(
    "progress event summaries never carry env-derived secrets",
    async () => {
      // Arrange — the agent echoes a token it found in its environment.
      const { fakes, cwd } = setup({
        steps: [
          { mode: "success", edits: { [`notes-${TOKEN}.md`]: "x" }, message: `env ${TOKEN}` },
        ],
      });

      // Act
      const handle = getRunner("claude-code").start(invocation(fakes, cwd));
      const summaries: string[] = [];
      for await (const event of handle.events) summaries.push(event.summary);
      await handle.result;

      // Assert
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.join("\n")).toContain("[REDACTED]");
      expect(summaries.join("\n")).not.toContain(TOKEN);
    },
    TIMEOUT,
  );

  test(
    "a wall time beyond the timer range does not stop the runner at once",
    async () => {
      // Arrange — 2^31 ms and above overflow setTimeout (it would fire after 1 ms).
      const { fakes, cwd } = setup({ steps: [{ mode: "success", delayMs: 300 }] });

      // Act
      const result = await getRunner("claude-code").start(
        invocation(fakes, cwd, { limits: { maxTurns: 3, maxBudgetUsd: null, wallTimeMs: 3e9 } }),
      ).result;

      // Assert
      expect(result.status).toBe("succeeded");
    },
    TIMEOUT,
  );

  test(
    "resume passes --resume <id> (no --session-id) with every containment flag",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "success" }] });

      // Act
      const handle = getRunner("claude-code").start(
        invocation(fakes, cwd, { resumeSessionId: SESSION }),
      );
      const result = await handle.result;

      // Assert
      const argv = fakes.records()[0]?.argv ?? [];
      expect(result.status).toBe("succeeded");
      expect(argv).not.toContain("--session-id");
      expect(argv[argv.indexOf("--resume") + 1]).toBe(SESSION);
      expect(argv).toEqual(
        expect.arrayContaining([
          "--permission-mode",
          "acceptEdits",
          "--settings",
          "--max-turns",
          "--disallowedTools",
        ]),
      );
    },
    TIMEOUT,
  );

  test(
    "API error, turn limit, and budget outcomes come from the result event",
    async () => {
      const { fakes, cwd } = setup({
        steps: [{ mode: "api-error" }, { mode: "max-turns" }, { mode: "budget", cost: 0.6 }],
      });
      const run = async () =>
        getRunner("claude-code").start(invocation(fakes, cwd, { model: "haiku" })).result;
      const apiError = await run();
      const turns = await run();
      const budget = await run();
      expect(apiError).toMatchObject({
        status: "failed",
        error: { id: "GROOT_E_RUNNER_UNAVAILABLE" },
      });
      expect(apiError.error?.message).toContain('"haiku"');
      expect(turns.error?.details).toMatchObject({ cause: "max-turns" });
      expect(budget).toMatchObject({ status: "budget-exceeded", usage: { costUsd: 0.6 } });
    },
    TIMEOUT,
  );

  test(
    "wall time stops a hung runner (timed-out) and leaves nothing running",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", grandchild: true }] });

      // Act
      const handle = getRunner("claude-code").start(
        invocation(fakes, cwd, { limits: { maxTurns: 3, maxBudgetUsd: null, wallTimeMs: 2500 } }),
      );
      const pid = await waitForStart(fakes);
      const result = await handle.result;

      // Assert
      expect(result.status).toBe("timed-out");
      expect(result.error?.details).toMatchObject({ cause: "wall-time" });
      expect(await groupMembers(pid)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "cancel: SIGINT to the group, survivors swept, no process of the group remains",
    async () => {
      // Arrange — the grandchild ignores SIGINT, so only the sweep can remove it.
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", grandchild: true }] });
      const handle = getRunner("claude-code").start(invocation(fakes, cwd));
      const pid = await fakes.waitReady();
      expect((await groupMembers(pid)).length).toBeGreaterThanOrEqual(2);

      // Act
      await handle.cancel();
      const result = await handle.result;

      // Assert
      expect(result.status).toBe("interrupted");
      expect(result.error?.id).toBe("GROOT_E_INTERRUPTED");
      expect(result.notes.join(" ")).toContain("terminated");
      expect(await groupMembers(pid)).toEqual([]);
      expect(readFileSync(join(cwd, "attempt-1.jsonl"), "utf8")).toContain('"signal":"SIGINT"');
    },
    TIMEOUT,
  );

  test(
    "a runner that ignores SIGINT is escalated to SIGTERM after the interrupt grace",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", ignoreSigint: true }] });
      const handle = getRunner("claude-code").start(
        invocation(fakes, cwd, { grace: { interruptMs: 400, terminateMs: 2000 } }),
      );
      const pid = await fakes.waitReady();

      // Act
      await handle.cancel();

      // Assert
      expect((await handle.result).status).toBe("interrupted");
      expect(readFileSync(join(cwd, "attempt-1.jsonl"), "utf8")).toContain('"signal":"SIGTERM"');
      expect(await groupMembers(pid)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "an abort signal interrupts the run even when the agent writes a final result on SIGINT",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", resultOnSigint: true }] });
      const controller = new AbortController();
      const handle = getRunner("claude-code").start(
        invocation(fakes, cwd, { signal: controller.signal }),
      );
      await fakes.waitReady();

      // Act
      controller.abort();
      const result = await handle.result;

      // Assert
      expect(result.status).toBe("interrupted");
      expect(result.usage).toMatchObject({ kind: "observed-cost", costUsd: 0.01 });
    },
    TIMEOUT,
  );
});

describe("runner groups never outlive their host", () => {
  test(
    "SIGHUP to a host that does not handle it kills the runner group, then exits 129",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", grandchild: true }] });
      const host = startHost(fakes, cwd);
      const runner = await fakes.waitReady();

      // Act
      const spawned = await host.line(/^spawned \d+$/);
      host.proc.kill("SIGHUP");
      const code = await host.proc.exited;

      // Assert — the host reported the runner's pid (= its group) as it spawned.
      expect(spawned).toBe(`spawned ${runner}`);
      expect(code).toBe(129);
      expect(await groupGone(runner)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "SIGTERM to a host without its own handler also kills the runner group (exit 143)",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", grandchild: true }] });
      const host = startHost(fakes, cwd);
      const runner = await fakes.waitReady();

      // Act
      host.proc.kill("SIGTERM");
      const code = await host.proc.exited;

      // Assert
      expect(code).toBe(143);
      expect(await groupGone(runner)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a host that handles SIGTERM itself (like the CLI) stays in charge: the run is cancelled",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "hang" }] });
      const host = startHost(fakes, cwd, ["--abort-on-sigterm"]);
      const runner = await fakes.waitReady();

      // Act
      host.proc.kill("SIGTERM");
      const code = await host.proc.exited;

      // Assert
      expect(await host.line(/^result /)).toBe("result interrupted");
      expect(code).toBe(0);
      expect(await groupGone(runner)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a recorded runner group is recognized only by its leader's start time, and can be stopped",
    async () => {
      // Arrange — a live group led by `sleep`, and one whose leader already exited.
      const leader = Bun.spawn(["sleep", "60"], { detached: true, stdout: "ignore" });
      const record = { pgid: leader.pid, startedAt: Date.now() };
      const orphaned = Bun.spawn(["sh", "-c", "sleep 60 & exit 0"], {
        detached: true,
        stdout: "ignore",
      });
      await orphaned.exited;

      // Act
      const ours = await inspectRunnerGroup(record);
      const recycled = await inspectRunnerGroup({ ...record, startedAt: record.startedAt - 3.6e6 });
      const leaderless = await inspectRunnerGroup({ pgid: orphaned.pid, startedAt: Date.now() });
      const stopped = await stopRunnerGroup(record.pgid);

      // Assert — a live leader that started at another time is a recycled pid: not ours.
      expect(ours).toBe("runner");
      expect(recycled).toBe("gone");
      expect(leaderless).toBe("unverified");
      expect(stopped).toBe(true);
      expect(await inspectRunnerGroup(record)).toBe("gone");
      killTree(orphaned.pid, "SIGKILL");
      expect(await groupGone(orphaned.pid)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("Codex adapter (simulated runner)", () => {
  test(
    "exec argv, tokens-only usage, non-fatal retry notices; --ignore-user-config only when help lists it",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({
        steps: [{ mode: "success", retryNotice: true, message: "ok" }],
      });

      // Act
      const result = await getRunner("codex").start(invocation(fakes, cwd, { model: "gpt-5.6" }))
        .result;

      // Assert
      const argv = fakes.records()[0]?.argv ?? [];
      expect(argv.slice(0, 8)).toEqual([
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "-C",
        cwd,
        "-c",
        'approval_policy="never"',
      ]);
      expect(argv).not.toContain("--ignore-user-config");
      expect(argv.at(-1)).toBe("-");
      expect(result).toMatchObject({
        status: "succeeded",
        simulated: true,
        usage: { kind: "tokens", costUsd: null, inputTokens: 1200 },
      });
      expect(fakes.records()[0]?.stdin).toBe("PROMPT-ON-STDIN: make it pass");
    },
    TIMEOUT,
  );

  test(
    "resume puts thread flags before `resume <thread> -`; modern help adds --ignore-user-config",
    async () => {
      // Arrange
      const { fakes, cwd } = setup({ steps: [{ mode: "success" }], help: "modern" });

      // Act
      const result = await getRunner("codex").start(
        invocation(fakes, cwd, { resumeSessionId: "thread-42" }),
      ).result;

      // Assert
      const argv = fakes.records()[0]?.argv ?? [];
      expect(argv.slice(-3)).toEqual(["resume", "thread-42", "-"]);
      expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("resume"));
      expect(argv).toContain("--ignore-user-config");
      expect(result.sessionId).toBe("thread-42");
    },
    TIMEOUT,
  );

  test(
    "usage limit (quota) and an unloadable config are blocked with their cause",
    async () => {
      const { fakes, cwd } = setup({ steps: [{ mode: "usage-limit" }, { mode: "config-error" }] });
      const quota = await getRunner("codex").start(invocation(fakes, cwd)).result;
      const config = await getRunner("codex").start(invocation(fakes, cwd)).result;
      expect(quota.error).toMatchObject({ id: "GROOT_E_BLOCKED", details: { cause: "quota" } });
      expect(config.error).toMatchObject({
        id: "GROOT_E_BLOCKED",
        details: { cause: "config-incompatible" },
      });
      expect(config.error?.message).toContain("unknown variant");
    },
    TIMEOUT,
  );

  test(
    "SIGINT mid-turn (no terminal event) is an interruption with no survivors",
    async () => {
      const { fakes, cwd } = setup({ steps: [{ mode: "hang", grandchild: true }] });
      const handle = getRunner("codex").start(invocation(fakes, cwd));
      const pid = await fakes.waitReady();
      await handle.cancel();
      const result = await handle.result;
      expect(result.status).toBe("interrupted");
      expect(result.notes.join(" ")).toContain("terminated");
      expect(await groupMembers(pid)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("discovery (simulated executables)", () => {
  test(
    "Codex: config-incompatible / not logged in / available are told apart",
    async () => {
      // Arrange
      const configBroken = tracked(installFakeAgents());
      configBroken.scenario({ steps: [], auth: "config-error" });
      const loggedOut = tracked(installFakeAgents());
      loggedOut.scenario({ steps: [], auth: "logged-out" });
      const ok = tracked(installFakeAgents());
      ok.scenario({ steps: [], auth: "ok" });

      // Act
      const [broken, out, fine] = await Promise.all([
        getRunner("codex").preflight(configBroken.env()),
        getRunner("codex").preflight(loggedOut.env()),
        getRunner("codex").preflight(ok.env()),
      ]);

      // Assert
      expect(broken.block?.cause).toBe("config-incompatible");
      expect(broken.block?.detail).toContain("config.toml:2:26");
      expect(broken.capabilities).toMatchObject({
        available: false,
        version: "0.116.0",
        auth: { status: "unknown" },
      });
      expect(out.block?.cause).toBe("unauthenticated");
      expect(out.capabilities.auth.status).toBe("unauthenticated");
      expect(fine.block).toBeNull();
      expect(fine.capabilities).toMatchObject({
        available: true,
        auth: { status: "authenticated", method: "chatgpt" },
      });
      expect(fine.capabilities.features).toMatchObject({
        usage: "tokens",
        budgetLimit: false,
        turnLimit: false,
      });
      expect(fine.capabilities.notes.join(" ")).toContain("no --ignore-user-config");
    },
    TIMEOUT,
  );

  test(
    "Claude Code: logged out and too-old builds are blocked; a current build is available with truthful features",
    async () => {
      // Arrange
      const loggedOut = tracked(installFakeAgents());
      loggedOut.scenario({ steps: [], auth: "logged-out" });
      const old = tracked(installFakeAgents());
      old.scenario({ steps: [], help: "old" });
      const ok = tracked(installFakeAgents());
      ok.scenario({ steps: [] });

      // Act
      const [out, tooOld, fine] = await Promise.all([
        getRunner("claude-code").preflight(loggedOut.env()),
        getRunner("claude-code").preflight(old.env()),
        getRunner("claude-code").preflight(ok.env()),
      ]);

      // Assert
      expect(out.block?.cause).toBe("unauthenticated");
      expect(tooOld.block?.cause).toBe("incompatible");
      expect(tooOld.block?.detail).toContain("--permission-prompts");
      expect(fine.block).toBeNull();
      expect(fine.capabilities.features).toMatchObject({
        structuredEvents: true,
        cancellation: "signal",
        resume: true,
        usage: "observed-cost",
        budgetLimit: true,
        turnLimit: true,
      });
      expect(fine.capabilities.features.permissionModes).toContain("acceptEdits");
    },
    TIMEOUT,
  );

  test(
    "discoverRunners returns one contract-valid document per runner",
    async () => {
      const fakes = tracked(installFakeAgents());
      const all = await discoverRunners(fakes.env());
      expect(all.map((caps) => caps.runner)).toEqual(["claude-code", "codex"]);
      for (const caps of all) expect(RunnerCapabilities.safeParse(caps).success).toBe(true);
      const missing = await discoverRunners({ PATH: "/nonexistent" });
      expect(missing.every((caps) => !caps.available && caps.executable === null)).toBe(true);
    },
    TIMEOUT,
  );
});
