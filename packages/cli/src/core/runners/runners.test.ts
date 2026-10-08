/**
 * Runner adapters, pure parts: argv construction with containment flags,
 * child-env scrubbing, stream-json / JSONL parsing and outcome
 * classification, usage extraction, discovery text classification, and real
 * executable resolution (wrapper-shim skipping, Codex's native binary).
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCapabilities } from "../contracts/task.ts";
import {
  bashRules,
  CLAUDE_SANDBOX_SETTINGS,
  claudeArgv,
  parseClaudeAuth,
  permissionModes,
} from "./claude.ts";
import { ClaudeStreamParser, claudeUsage } from "./claude-stream.ts";
import { classifyCodexLogin, codexArgv, parseCodexHelp } from "./codex.ts";
import { CodexStreamParser, classifyCodexText } from "./codex-stream.ts";
import { assertSafeArg, buildCapabilities, flagBlock, parseVersion } from "./common.ts";
import { isScrubbed, knownSecretsFromEnv, runnerEnv } from "./env.ts";
import { codexNativeBehindLauncher, isWrapperShim, resolveExecutable } from "./resolve.ts";
import type { SupervisedExit } from "./supervise.ts";
import type { RunnerInvocation } from "./types.ts";

const SESSION = "3cb83b15-1b2c-4d5e-8f90-123456789abc";

function invocation(overrides: Partial<RunnerInvocation> = {}): RunnerInvocation {
  return {
    cwd: "/tmp/wt",
    prompt: "SECRET-PROMPT-TEXT fix the bug",
    sessionId: SESSION,
    limits: { maxTurns: 12, maxBudgetUsd: 0.75, wallTimeMs: 600_000 },
    allowedCommands: ["bun test", "git status"],
    eventsLogPath: "/tmp/wt/log.jsonl",
    signal: new AbortController().signal,
    systemPrompt: "task rules",
    ...overrides,
  };
}

function exitOf(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError: null,
    stderrTail: "",
    durationMs: 1234,
    survivors: 0,
    leftover: 0,
    ...overrides,
  };
}

const lines = (...docs: Record<string, unknown>[]): string[] =>
  docs.map((doc) => JSON.stringify(doc));

const CONTEXT = { model: "opus", maxTurns: 12, maxBudgetUsd: 0.75, wallTimeMs: 600_000 };

function feed(parser: ClaudeStreamParser | CodexStreamParser, raw: readonly string[]) {
  return raw.map((line) => parser.line(line));
}

describe("Claude Code argv", () => {
  test("every containment flag is present, the prompt is not on argv, nothing dangerous is passed", () => {
    // Act
    const argv = claudeArgv("/bin/claude", invocation({ model: "opus", effort: "low" }));

    // Assert
    expect(argv.slice(0, 5)).toEqual([
      "/bin/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    const pairs = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(pairs("--session-id")).toBe(SESSION);
    expect(pairs("--permission-mode")).toBe("acceptEdits");
    expect(pairs("--permission-prompts")).toBe("none");
    expect(argv).toContain("--strict-mcp-config");
    expect(pairs("--max-turns")).toBe("12");
    expect(pairs("--max-budget-usd")).toBe("0.75");
    expect(pairs("--model")).toBe("opus");
    expect(pairs("--effort")).toBe("low");
    expect(pairs("--settings")).toBe(CLAUDE_SANDBOX_SETTINGS);
    expect(JSON.parse(CLAUDE_SANDBOX_SETTINGS)).toEqual({
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
    });
    expect(pairs("--append-system-prompt")).toBe("task rules");
    const allowed = argv.slice(
      argv.indexOf("--allowedTools") + 1,
      argv.indexOf("--disallowedTools"),
    );
    expect(allowed).toEqual([
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(bun test)",
      "Bash(bun test *)",
      "Bash(git status)",
      "Bash(git status *)",
    ]);
    const denied = argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--settings"));
    expect(denied).toEqual(["Bash(git push *)", "Bash(git commit *)", "WebFetch", "WebSearch"]);
    const joined = argv.join(" ");
    expect(joined).not.toContain("SECRET-PROMPT-TEXT");
    for (const forbidden of ["dangerously", "--yolo", "bypassPermissions", "--bare"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  test("resume re-passes every flag with --resume instead of --session-id", () => {
    // Act
    const start = claudeArgv("/bin/claude", invocation());
    const resume = claudeArgv("/bin/claude", invocation({ resumeSessionId: SESSION }));

    // Assert
    expect(resume).not.toContain("--session-id");
    expect(resume[resume.indexOf("--resume") + 1]).toBe(SESSION);
    const withoutSession = (argv: string[]) =>
      argv.filter((arg) => !["--session-id", "--resume", SESSION].includes(arg));
    expect(withoutSession(resume)).toEqual(withoutSession(start));
  });

  test("values that could be read as flags are refused before anything spawns", () => {
    expect(() =>
      claudeArgv("/bin/claude", invocation({ model: "--dangerously-skip-permissions" })),
    ).toThrow(/Invalid model/);
    expect(() => claudeArgv("/bin/claude", invocation({ effort: "ultra" }))).toThrow(/effort/);
    expect(() => claudeArgv("/bin/claude", invocation({ sessionId: "not-a-uuid" }))).toThrow(
      /UUID/,
    );
    expect(assertSafeArg("model", "claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  test("only shell-free command prefixes become Bash allow rules", () => {
    expect(bashRules(["bun test", "rm -rf / ; echo", "echo $(id)", "bun run lint"])).toEqual([
      "Bash(bun test)",
      "Bash(bun test *)",
      "Bash(bun run lint)",
      "Bash(bun run lint *)",
    ]);
  });
});

describe("Claude Code stream-json", () => {
  test("captures init, ignores unknown types and ui_invalidate, and succeeds only on is_error=false + completed", () => {
    // Arrange
    const parser = new ClaudeStreamParser(CONTEXT);

    // Act
    const events = feed(parser, [
      ...lines(
        { type: "system", subtype: "ui_invalidate", event: "ui.render" },
        {
          type: "system",
          subtype: "init",
          session_id: SESSION,
          model: "claude-opus-5-5",
          permissionMode: "acceptEdits",
          claude_code_version: "2.1.293",
        },
        { type: "brand_new_event", payload: 1 },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          terminal_reason: "completed",
          num_turns: 4,
          result: "Fixed it.",
          total_cost_usd: 0.0421,
          modelUsage: {
            "claude-opus-5-5": {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 20,
              provider: "foundry",
              costBasis: "list",
            },
          },
        },
      ),
      "not json at all",
    ]);
    const result = parser.finish(exitOf());

    // Assert
    expect(events.map((event) => event?.kind)).toEqual([
      "notice",
      "session",
      "unknown",
      "tool",
      "result",
      "unknown",
    ]);
    expect(events[3]?.summary).toBe("Bash bun test");
    expect(parser.model).toBe("claude-opus-5-5");
    expect(parser.version).toBe("2.1.293");
    expect(result.status).toBe("succeeded");
    expect(result.sessionId).toBe(SESSION);
    expect(result.finalMessage).toBe("Fixed it.");
    expect(result.usage).toMatchObject({
      kind: "observed-cost",
      costUsd: 0.0421,
      inputTokens: 130,
      outputTokens: 5,
      cachedInputTokens: 100,
      turns: 4,
    });
    expect(result.usage.source).toContain("ESTIMATE");
    expect(result.notes).toContain("Claude Code 2.1.293");
  });

  test('an API 404 with subtype "success" and is_error=true is a failure (model unavailable)', () => {
    // Arrange
    const parser = new ClaudeStreamParser(CONTEXT);
    feed(
      parser,
      lines(
        {
          type: "assistant",
          message: { model: "<synthetic>", content: [] },
          error: "model_not_found",
          is_api_error_message: true,
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 404,
          terminal_reason: "api_error",
          total_cost_usd: 0,
        },
      ),
    );

    // Act
    const result = parser.finish(exitOf({ exitCode: 1 }));

    // Assert
    expect(result.status).toBe("failed");
    expect(result.error?.id).toBe("GROOT_E_RUNNER_UNAVAILABLE");
    expect(result.error?.message).toContain('Model "opus" is not available');
    expect(result.error?.details).toMatchObject({ cause: "model-unavailable", httpStatus: 404 });
  });

  test("authentication and billing API errors are blocked, not retried", () => {
    for (const [apiError, cause] of [
      ["authentication_failed", "unauthenticated"],
      ["billing_error", "quota"],
    ] as const) {
      const parser = new ClaudeStreamParser(CONTEXT);
      feed(
        parser,
        lines(
          { type: "assistant", error: apiError, message: { content: [] } },
          { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error" },
        ),
      );
      const result = parser.finish(exitOf({ exitCode: 1 }));
      expect(result.error?.id).toBe("GROOT_E_BLOCKED");
      expect(result.error?.details).toMatchObject({ cause });
    }
  });

  test("turn and budget limits are classified from subtype/terminal_reason", () => {
    // Arrange
    const turns = new ClaudeStreamParser(CONTEXT);
    feed(
      turns,
      lines({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
        total_cost_usd: 0.3,
      }),
    );
    const budget = new ClaudeStreamParser(CONTEXT);
    feed(
      budget,
      lines({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        terminal_reason: "budget_exhausted",
        total_cost_usd: 0.8,
      }),
    );

    // Act
    const turnResult = turns.finish(exitOf({ exitCode: 1 }));
    const budgetResult = budget.finish(exitOf({ exitCode: 1 }));

    // Assert
    expect(turnResult.status).toBe("failed");
    expect(turnResult.error?.details).toMatchObject({ cause: "max-turns" });
    expect(budgetResult.status).toBe("budget-exceeded");
    expect(budgetResult.usage.costUsd).toBe(0.8);
  });

  test("cancellation and wall-time outrank any result; no result means usage unknown", () => {
    // Arrange
    const parser = new ClaudeStreamParser(CONTEXT);
    feed(
      parser,
      lines({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed" }),
    );

    // Act / Assert
    expect(parser.finish(exitOf({ cancelled: true })).status).toBe("interrupted");
    expect(parser.finish(exitOf({ timedOut: true })).status).toBe("timed-out");
    const empty = new ClaudeStreamParser(CONTEXT).finish(exitOf({ exitCode: 0 }));
    expect(empty.status).toBe("failed");
    expect(empty.error?.details).toMatchObject({ cause: "no-result" });
    expect(empty.usage.kind).toBe("unavailable");
    expect(claudeUsage(null, 5).source).toContain("usage unknown");
  });

  test("a non-zero exit after a success result is not a success", () => {
    const parser = new ClaudeStreamParser(CONTEXT);
    feed(
      parser,
      lines({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed" }),
    );
    expect(parser.finish(exitOf({ exitCode: 1 })).status).toBe("failed");
  });
});

describe("Codex argv and JSONL", () => {
  test("exec argv: explicit sandbox + approval policy, prompt on stdin, flags before resume", () => {
    // Act
    const start = codexArgv("/bin/codex", invocation({ model: "gpt-5.6" }), {
      ignoreUserConfig: false,
    });
    const resume = codexArgv("/bin/codex", invocation({ resumeSessionId: "thread-1" }), {
      ignoreUserConfig: true,
    });

    // Assert
    expect(start).toEqual([
      "/bin/codex",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-C",
      "/tmp/wt",
      "-c",
      'approval_policy="never"',
      "-m",
      "gpt-5.6",
      "-",
    ]);
    expect(resume.slice(-3)).toEqual(["resume", "thread-1", "-"]);
    expect(resume.indexOf("--sandbox")).toBeLessThan(resume.indexOf("resume"));
    expect(resume.indexOf("-C")).toBeLessThan(resume.indexOf("resume"));
    expect(resume).toContain("--ignore-user-config");
    for (const forbidden of ["dangerously", "--yolo", "--full-auto"]) {
      expect(start.join(" ")).not.toContain(forbidden);
    }
  });

  test("usage is tokens-only with optional fields; non-fatal error events don't fail the run", () => {
    // Arrange
    const parser = new CodexStreamParser(60_000);

    // Act
    feed(
      parser,
      lines(
        { type: "thread.started", thread_id: "thread-9" },
        { type: "turn.started" },
        { type: "error", message: "Reconnecting... 2/5 (stream disconnected)" },
        { type: "item.completed", item: { type: "agent_message", text: "All green." } },
        { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 50 } },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            output_tokens: 1,
            reasoning_output_tokens: 1,
          },
        },
      ),
    );
    const result = parser.finish(exitOf());

    // Assert
    expect(result.status).toBe("succeeded");
    expect(result.sessionId).toBe("thread-9");
    expect(result.finalMessage).toBe("All green.");
    expect(result.usage).toMatchObject({
      kind: "tokens",
      costUsd: null,
      inputTokens: 1010,
      cachedInputTokens: 4,
      outputTokens: 51,
      turns: 2,
    });
    expect(result.usage.source).toContain("no cost");
  });

  test("turn.failed with a usage-limit message is blocked (quota); a config error with no JSONL is blocked (config)", () => {
    // Arrange
    const quota = new CodexStreamParser(60_000);
    feed(
      quota,
      lines(
        { type: "thread.started", thread_id: "t" },
        {
          type: "turn.failed",
          error: { message: "You've hit your usage limit. Try again at 4:22 PM." },
        },
      ),
    );
    const config = new CodexStreamParser(60_000);

    // Act
    const quotaResult = quota.finish(exitOf({ exitCode: 1 }));
    const configResult = config.finish(
      exitOf({
        exitCode: 1,
        stderrTail: "Error loading config.toml: unknown variant `ultra`, expected one of `none`",
      }),
    );

    // Assert
    expect(quotaResult.error).toMatchObject({ id: "GROOT_E_BLOCKED", details: { cause: "quota" } });
    expect(configResult.error).toMatchObject({
      id: "GROOT_E_BLOCKED",
      details: { cause: "config-incompatible" },
    });
    expect(configResult.usage.kind).toBe("unavailable");
  });

  test("text classification checks config errors first (login status exits 1 for both)", () => {
    expect(
      classifyCodexText("Error loading configuration: /x/config.toml:2:26: unknown variant")?.cause,
    ).toBe("config-incompatible");
    expect(classifyCodexText("Not logged in")?.cause).toBe("unauthenticated");
    expect(classifyCodexText("You've hit your usage limit")?.cause).toBe("quota");
    expect(classifyCodexText("something else")).toBeNull();
  });

  test("login status classification keeps the exact file:line detail and never suggests editing the config for the user", () => {
    // Act
    const config = classifyCodexLogin(
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error loading configuration: /home/u/.codex/config.toml:2:26: unknown variant `ultra`",
      },
      "0.116.0",
    );
    const loggedOut = classifyCodexLogin(
      { exitCode: 1, stdout: "", stderr: "Not logged in" },
      "0.116.0",
    );
    const ok = classifyCodexLogin(
      { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" },
      "0.116.0",
    );

    // Assert
    expect(config.block?.cause).toBe("config-incompatible");
    expect(config.block?.detail).toContain("config.toml:2:26");
    expect(config.block?.nextStep).toContain("never edits");
    expect(loggedOut).toMatchObject({
      status: "unauthenticated",
      block: { cause: "unauthenticated" },
    });
    expect(ok).toMatchObject({ status: "authenticated", method: "chatgpt", block: null });
  });
});

describe("discovery parsing", () => {
  test("help parsing reads one flag's block, not the rest of the help", () => {
    // Arrange
    const help = [
      '  --output-format <format>  Output (choices: "text", "json")',
      "  --permission-mode <mode>  Permission mode",
      '                            (choices: "acceptEdits", "auto",',
      '                            "plan")',
      '  --tmux <mode>             tmux (choices: "on", "off")',
    ].join("\n");

    // Act / Assert
    expect(permissionModes(help)).toEqual(["acceptEdits", "auto", "plan"]);
    expect(flagBlock(help, "--tmux")).toContain('"on"');
    expect(
      parseCodexHelp(
        "  -s, --sandbox <MODE>\n          [possible values: read-only, workspace-write]\n      --json\n",
      ).sandboxModes,
    ).toEqual(["read-only", "workspace-write"]);
    expect(parseCodexHelp("      --ignore-user-config\n      --json\n").ignoreUserConfig).toBe(
      true,
    );
    expect(parseVersion("codex-cli 0.116.0")).toBe("0.116.0");
    expect(parseVersion("2.1.293 (Claude Code)")).toBe("2.1.293");
  });

  test("claude auth status JSON maps to authenticated / unauthenticated / unknown", () => {
    expect(
      parseClaudeAuth(
        0,
        '{"loggedIn":true,"authMethod":"third_party","apiProvider":"foundry"}',
        "",
      ),
    ).toMatchObject({ status: "authenticated", method: "third_party" });
    expect(parseClaudeAuth(1, '{"loggedIn":false,"authMethod":"none"}', "").status).toBe(
      "unauthenticated",
    );
    expect(parseClaudeAuth(0, "garbage", "").status).toBe("unknown");
  });

  test("capabilities documents validate against the contract", () => {
    const caps = buildCapabilities({
      runner: "codex",
      available: false,
      executable: null,
      version: null,
      interface: "x",
      auth: { status: "unknown", method: null, detail: "" },
      features: {
        structuredEvents: true,
        cancellation: "signal",
        resume: true,
        permissionModes: [],
        usage: "tokens",
        budgetLimit: false,
        turnLimit: false,
        sandbox: "os",
      },
      notes: [],
    });
    expect(RunnerCapabilities.safeParse(caps).success).toBe(true);
  });
});

describe("runner child environment", () => {
  test("session, preload, and multiplexer variables are scrubbed; provider selectors are kept", () => {
    // Arrange
    const base = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/x",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_PID: "1",
      CLAUDE_EFFORT: "max",
      NODE_OPTIONS: "--require x",
      CMUX_SURFACE_ID: "abc",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://example",
    };

    // Act
    const claude = runnerEnv(base, "claude-code");
    const codex = runnerEnv(base, "codex", {
      prependPath: ["/vendor/path"],
      extra: { CODEX_MANAGED_BY_BUN: "1" },
    });

    // Assert
    for (const name of Object.keys(base).filter(isScrubbed)) expect(claude[name]).toBeUndefined();
    expect(Object.keys(base).filter(isScrubbed)).toHaveLength(11);
    expect(claude).toMatchObject({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(codex.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    expect(codex.PATH).toBe("/vendor/path:/usr/bin");
    expect(codex.CODEX_MANAGED_BY_BUN).toBe("1");
  });

  test("sensitive variable values become known secrets for log redaction", () => {
    expect(
      knownSecretsFromEnv({
        ANTHROPIC_FOUNDRY_AUTH_TOKEN: "tok-1234567890",
        HOME: "/Users/someone",
        SHORT_TOKEN: "abc",
      }),
    ).toEqual(["tok-1234567890"]);
  });
});

describe("executable resolution", () => {
  function scratch(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "groot-resolve-")));
  }

  function script(path: string, body: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  test("an explicit GROOT_CLAUDE_PATH is honored exactly", () => {
    const dir = scratch();
    const exe = script(join(dir, "my-claude"), "#!/bin/sh\nexit 0\n");
    const resolution = resolveExecutable("claude-code", { GROOT_CLAUDE_PATH: exe, PATH: "" });
    expect(resolution.executable).toMatchObject({ path: exe, kind: "override" });
    expect(
      resolveExecutable("claude-code", { GROOT_CLAUDE_PATH: join(dir, "missing"), PATH: "" })
        .executable,
    ).toBeNull();
  });

  test("cmux shims and exec-wrapper scripts on PATH are skipped (and noted) in favor of the real binary", () => {
    // Arrange
    const dir = scratch();
    const shimDir = join(dir, "cmux-cli-shims", "ABC");
    script(
      join(shimDir, "claude"),
      '#!/usr/bin/env bash\nexec "/Applications/cmux.app/x/cmux-claude-wrapper" "$@"\n',
    );
    const wrapperDir = join(dir, "wrapped");
    script(join(wrapperDir, "claude"), '#!/bin/sh\nexec "$HOME/bin/claude-wrapper" "$@"\n');
    const realDir = join(dir, "real");
    const real = script(join(realDir, "claude"), "#!/bin/sh\necho real\n");

    // Act
    const resolution = resolveExecutable("claude-code", {
      PATH: [shimDir, wrapperDir, realDir].join(":"),
    });

    // Assert
    expect(resolution.executable?.path).toBe(real);
    expect(resolution.notes.filter((note) => note.startsWith("skipped wrapper shim"))).toHaveLength(
      2,
    );
    expect(isWrapperShim("/x/cmux-cli-shims/1/codex", "")).toBe(true);
    expect(isWrapperShim("/usr/bin/claude", "#!/usr/bin/env node\nrequire('cli.js')")).toBe(false);
  });

  test("only wrappers on PATH → not found, with a hint to set the override", () => {
    const dir = scratch();
    const shimDir = join(dir, "cmux-cli-shims", "A");
    script(join(shimDir, "codex"), '#!/bin/bash\nexec cmux-codex-wrapper "$@"\n');
    const resolution = resolveExecutable("codex", { PATH: shimDir });
    expect(resolution.executable).toBeNull();
    expect(resolution.notes.join(" ")).toContain("GROOT_CODEX_PATH");
  });

  test("the Codex npm launcher resolves to the native vendor binary with its PATH prepend", () => {
    // Arrange
    const triples: Record<string, string> = {
      "darwin-x64": "x86_64-apple-darwin",
      "darwin-arm64": "aarch64-apple-darwin",
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
    };
    const triple = triples[`${process.platform}-${process.arch}`];
    if (triple === undefined) return;
    const dir = scratch();
    const modules = join(dir, "install", "global", "node_modules", "@openai");
    const launcher = script(
      join(modules, "codex", "bin", "codex.js"),
      "#!/usr/bin/env node\n// launcher\n",
    );
    const vendor = join(modules, `codex-${process.platform}-${process.arch}`, "vendor", triple);
    const native = script(join(vendor, "codex", "codex"), "#!/bin/sh\necho native\n");
    mkdirSync(join(vendor, "path"), { recursive: true });
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(launcher, join(binDir, "codex"));

    // Act
    const resolution = resolveExecutable("codex", { PATH: binDir });

    // Assert
    expect(codexNativeBehindLauncher(launcher)?.path).toBe(native);
    expect(resolution.executable).toMatchObject({
      path: native,
      kind: "native",
      prependPath: [join(vendor, "path")],
    });
    expect(resolution.notes.join(" ")).toContain("native Codex binary behind the npm launcher");
  });
});
