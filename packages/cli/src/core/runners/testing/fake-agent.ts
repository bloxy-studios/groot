/**
 * SIMULATED runner — a stand-in for `claude` and `codex` used by tests and
 * demos (never by production code). Launched through a tiny shim written by
 * fake-agents.ts; behavior comes from `$GROOT_FAKE_DIR/scenario.json`, one
 * step per run invocation (the last step repeats). It reads the prompt from
 * stdin, emits the recorded event shapes from the runner research notes,
 * optionally edits files in its cwd, and honors SIGINT like the real tools.
 * Every event it emits carries `"simulated": true`, so results produced
 * through it are labelled simulated end to end.
 *
 * Each invocation appends {kind, argv, cwd, stdin, envNames, env(allowlist)}
 * to `$GROOT_FAKE_DIR/records.jsonl` — values of other variables are never
 * recorded.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FakeStep {
  readonly mode:
    | "success"
    | "api-error"
    | "max-turns"
    | "budget"
    | "hang"
    | "usage-limit"
    | "config-error"
    | "turn-failed"
    /** Claude: exit 1 before any session exists (no init, no result). */
    | "crash";
  /** Claude "success": run `git update-ref <ref> <to>` in the cwd (a sandbox escape). */
  readonly moveRef?: { readonly ref: string; readonly to: string };
  /** Files to write in the working directory (relative path → content). */
  readonly edits?: Readonly<Record<string, string>>;
  readonly message?: string;
  readonly cost?: number;
  /** "hang": start a child that ignores SIGINT, so the group sweep has work to do. */
  readonly grandchild?: boolean;
  /** "hang": ignore SIGINT (forces SIGTERM escalation). */
  readonly ignoreSigint?: boolean;
  /** "hang": on SIGINT write a final result first (Claude finishing the turn). */
  readonly resultOnSigint?: boolean;
  /** "api-error": the assistant error code (default model_not_found). */
  readonly apiError?: string;
  /** Emit a non-fatal Codex `error` (retry notice) before succeeding. */
  readonly retryNotice?: boolean;
  /** "success": work this long before finishing (makes concurrency observable). */
  readonly delayMs?: number;
  /** "success": finish only once this file exists (a test decides when; at most 2 minutes). */
  readonly waitForFile?: string;
}

export interface FakeScenario {
  readonly steps: readonly FakeStep[];
  readonly version?: string;
  readonly auth?: "ok" | "logged-out" | "config-error";
  /** Claude: "old" drops --permission-prompts. Codex: "modern" lists --ignore-user-config. */
  readonly help?: "current" | "old" | "modern";
  /**
   * Claude: "known" behaves like the real CLI — `--resume` of a session this
   * fake never started fails with "No conversation found" (default "any").
   */
  readonly sessions?: "any" | "known";
  /** Delay discovery probes (--version, --help, auth status); `probing` marks the first. */
  readonly probeDelayMs?: number;
}

const ENV_ALLOWLIST = [
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CODEX_MANAGED_BY_BUN",
  "PATH",
];

const kind = process.env.GROOT_FAKE_KIND === "codex" ? "codex" : "claude";
const dir = process.env.GROOT_FAKE_DIR ?? "";
const argv = process.argv.slice(2);

function scenario(): FakeScenario {
  const path = join(dir, "scenario.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as FakeScenario)
    : { steps: [{ mode: "success" }] };
}

function nextStep(spec: FakeScenario): FakeStep {
  const counter = join(dir, `count-${kind}`);
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  return spec.steps[Math.min(n, spec.steps.length - 1)] ?? { mode: "success" };
}

function record(stdin: string): void {
  const env = Object.fromEntries(ENV_ALLOWLIST.map((name) => [name, process.env[name] ?? null]));
  const line = {
    kind,
    argv,
    cwd: process.cwd(),
    stdin,
    pid: process.pid,
    envNames: Object.keys(process.env).sort(),
    env,
  };
  appendFileSync(join(dir, "records.jsonl"), `${JSON.stringify(line)}\n`);
}

const emit = (doc: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...doc, simulated: true })}\n`);
};

function flagValue(name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function applyEdits(edits: Readonly<Record<string, string>> | undefined): string[] {
  const paths = Object.keys(edits ?? {});
  for (const path of paths) {
    const absolute = join(process.cwd(), path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, edits?.[path] ?? "");
  }
  return paths;
}

async function exit(code: number): Promise<never> {
  // Flush stdout before exiting (piped output can be cut short otherwise).
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

/**
 * Leave a background `sleep` in the process group that ignores SIGINT and
 * that Bun does not track (its shell exits at once) — like a dev server an
 * agent started. Only Groot's process-group sweep can remove it.
 */
async function startGrandchild(): Promise<void> {
  const sh = Bun.spawn(["sh", "-c", 'trap "" INT; sleep 600 & exit 0'], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  await sh.exited; // the background sleep exists once its shell has exited
}

/**
 * Install SIGINT behavior BEFORE the invocation is recorded as started (a
 * real agent installs its handlers at startup), so a test that signals as
 * soon as it sees the record never hits the default action.
 */
function armInterrupt(step: FakeStep, onInterrupt: () => Promise<never>): void {
  process.on("SIGINT", () => {
    if (step.ignoreSigint === true) return;
    void onInterrupt();
  });
}

/** Poll for a file a test creates (bounded, so a broken test cannot hang the fake forever). */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(50);
}

/** Block until signalled; `ready.jsonl` says when everything the step starts is running. */
async function hang(step: FakeStep): Promise<never> {
  setInterval(() => {}, 1000);
  if (step.grandchild === true) await startGrandchild();
  appendFileSync(join(dir, "ready.jsonl"), `${JSON.stringify({ pid: process.pid })}\n`);
  return new Promise<never>(() => {});
}

// ---------------------------------------------------------------- claude

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --allowedTools, --allowed-tools <tools...>
  --append-system-prompt <prompt>       Append a system prompt to the default
  --disallowedTools, --disallowed-tools <tools...>
  --effort <level>                      Effort level (low, medium, high, xhigh, max)
  --max-budget-usd <amount>             Maximum dollar amount to spend on API
  --model <model>                       Model for the current session
  --output-format <format>              Output format: "text", "json", "stream-json"
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts
  -r, --resume [value]                  Resume a conversation by session ID
  --safe-mode                           Start with all customizations disabled
  --session-id <uuid>                   Use a specific session ID
  --settings <file-or-json>             Additional settings
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --tools <tools...>                    Specify the list of available tools
  --verbose                             Override verbose mode setting
`;

function claudeResult(step: FakeStep, sessionId: string): Record<string, unknown> {
  const cost = step.cost ?? 0.0123;
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    stop_reason: "end_turn",
    num_turns: 3,
    duration_ms: 1200,
    result: step.message ?? "Done.",
    total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 20 },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        costUSD: cost,
        provider: "foundry",
        costBasis: "list",
      },
    },
    permission_denials: [],
    session_id: sessionId,
  };
}

function claudeFailure(step: FakeStep, sessionId: string): Record<string, unknown> {
  const base = { type: "result", is_error: true, num_turns: 2, session_id: sessionId };
  if (step.mode === "max-turns") {
    return {
      ...base,
      subtype: "error_max_turns",
      terminal_reason: "max_turns",
      total_cost_usd: 0.02,
    };
  }
  if (step.mode === "budget") {
    return {
      ...base,
      subtype: "error_max_budget_usd",
      terminal_reason: "budget_exhausted",
      total_cost_usd: step.cost ?? 0.8,
    };
  }
  // API errors arrive as subtype "success" with is_error true (verified probe).
  return {
    ...base,
    subtype: "success",
    api_error_status: 404,
    terminal_reason: "api_error",
    total_cost_usd: 0,
    result: "There's an issue with the selected model.",
  };
}

function claudeInterrupted(step: FakeStep, sessionId: string): Promise<never> {
  if (step.resultOnSigint === true) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      total_cost_usd: 0.01,
      session_id: sessionId,
    });
  }
  return exit(0);
}

/** Without --tools the real CLI exposes its whole default surface (agents, cron, messaging…). */
const DEFAULT_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];

async function claudeRun(step: FakeStep, sessionId: string): Promise<never> {
  emit({ type: "system", subtype: "ui_invalidate", event: "ui.render" });
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: flagValue("--tools")?.split(",") ?? DEFAULT_TOOLS,
    model: "claude-opus-5-5",
    permissionMode: flagValue("--permission-mode") ?? "default",
    claude_code_version: "2.1.293",
    apiKeySource: "none",
  });
  emit({ type: "rate_limit_event", info: { status: "allowed" } });
  if (step.mode === "hang") {
    emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 600" } }] },
    });
    return hang(step);
  }
  if (step.mode === "api-error") {
    emit({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "model not found" }] },
      error: step.apiError ?? "model_not_found",
      is_api_error_message: true,
    });
    emit(claudeFailure(step, sessionId));
    return exit(1);
  }
  const edited = applyEdits(step.edits);
  for (const path of edited) {
    emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] },
    });
    emit({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
  }
  if (step.moveRef !== undefined) {
    Bun.spawnSync(["git", "update-ref", step.moveRef.ref, step.moveRef.to], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  if (step.delayMs !== undefined) await Bun.sleep(step.delayMs);
  if (step.waitForFile !== undefined) await waitForFile(step.waitForFile);
  if (step.mode !== "success") {
    emit(claudeFailure(step, sessionId));
    return exit(1);
  }
  emit({
    type: "assistant",
    message: { content: [{ type: "text", text: step.message ?? "Done." }] },
  });
  emit(claudeResult(step, sessionId));
  return exit(0);
}

const SESSIONS = join(dir, "sessions.txt");

function knownSessions(): string[] {
  return existsSync(SESSIONS) ? readFileSync(SESSIONS, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * Real Claude (2.1.293, print mode) refuses a resume target it has no
 * transcript for: the message on stderr and — with stream-json — a result
 * line carrying the message and its OWN fresh session id (never persisted),
 * then exit 1. No `system/init` precedes it.
 */
async function rejectUnknownResume(spec: FakeScenario, stdin: () => Promise<string>) {
  const resume = flagValue("--resume");
  if (spec.sessions !== "known" || resume === null || knownSessions().includes(resume)) return;
  record(await stdin());
  const message = `No conversation found with session ID: ${resume}`;
  console.error(message);
  if (flagValue("--output-format") === "stream-json") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: crypto.randomUUID(),
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [message],
    });
  }
  await exit(1);
}

async function probeDelay(spec: FakeScenario): Promise<void> {
  if (spec.probeDelayMs === undefined) return;
  writeFileSync(join(dir, "probing"), String(process.pid));
  await Bun.sleep(spec.probeDelayMs);
}

async function claude(spec: FakeScenario, stdin: () => Promise<string>): Promise<never> {
  const probing = argv[0] === "--version" || argv[0] === "--help" || argv[0] === "auth";
  if (probing) await probeDelay(spec);
  if (argv[0] === "--version") {
    console.log(`${spec.version ?? "2.1.293"} (Claude Code)`);
    return exit(0);
  }
  if (argv[0] === "--help") {
    console.log(
      spec.help === "old" ? CLAUDE_HELP.replace(/ {2}--permission-prompts.*\n/, "") : CLAUDE_HELP,
    );
    return exit(0);
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    const loggedIn = spec.auth !== "logged-out";
    console.log(
      JSON.stringify({
        loggedIn,
        authMethod: loggedIn ? "third_party" : "none",
        apiProvider: loggedIn ? "foundry" : "firstParty",
      }),
    );
    return exit(loggedIn ? 0 : 1);
  }
  if (!argv.includes("-p")) {
    console.error("fake claude: refusing to run without -p");
    return exit(2);
  }
  await rejectUnknownResume(spec, stdin);
  const step = nextStep(spec);
  const sessionId = flagValue("--session-id") ?? flagValue("--resume") ?? "unknown";
  if (step.mode === "hang") armInterrupt(step, () => claudeInterrupted(step, sessionId));
  record(await stdin());
  if (step.mode === "crash") {
    console.error("fake claude: crashed before the session started");
    return exit(1);
  }
  if (flagValue("--session-id") !== null) appendFileSync(SESSIONS, `${sessionId}\n`);
  return claudeRun(step, sessionId);
}

// ----------------------------------------------------------------- codex

const CODEX_HELP = (modern: boolean): string => `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  help    Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
${modern ? "      --ignore-user-config\n" : ""}      --json
          Print events to stdout as JSONL
`;

const CONFIG_ERROR =
  "Error loading configuration: /home/user/.codex/config.toml:2:26: unknown variant `ultra`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`";
const USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:22 PM.";

async function codexRun(step: FakeStep): Promise<never> {
  if (step.mode === "config-error") {
    console.error(CONFIG_ERROR.replace("configuration: ", "config.toml: "));
    return exit(1);
  }
  const resumeAt = argv.indexOf("resume");
  const threadId = resumeAt === -1 ? crypto.randomUUID() : (argv[resumeAt + 1] ?? "unknown");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  if (step.mode === "hang") return hang(step);
  if (step.mode === "usage-limit" || step.mode === "turn-failed") {
    const message = step.mode === "usage-limit" ? USAGE_LIMIT : (step.message ?? "boom");
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    return exit(1);
  }
  if (step.retryNotice === true) {
    emit({ type: "error", message: "Reconnecting... 1/5 (stream disconnected)" });
  }
  emit({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "bun test",
      status: "completed",
      exit_code: 0,
    },
  });
  const edited = applyEdits(step.edits);
  if (step.delayMs !== undefined) await Bun.sleep(step.delayMs);
  if (edited.length > 0) {
    emit({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "file_change",
        status: "completed",
        changes: edited.map((path) => ({ path, kind: "update" })),
      },
    });
  }
  emit({
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: step.message ?? "Done." },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 80 },
  });
  return exit(0);
}

async function codex(spec: FakeScenario, stdin: () => Promise<string>): Promise<never> {
  if (argv[0] === "--version") {
    console.log(`codex-cli ${spec.version ?? "0.116.0"}`);
    return exit(0);
  }
  if (argv[0] === "exec" && argv[1] === "--help") {
    console.log(CODEX_HELP(spec.help === "modern"));
    return exit(0);
  }
  if (argv[0] === "login" && argv[1] === "status") {
    if (spec.auth === "config-error") {
      console.error(CONFIG_ERROR);
      return exit(1);
    }
    if (spec.auth === "logged-out") {
      console.error("Not logged in");
      return exit(1);
    }
    console.log("Logged in using ChatGPT");
    return exit(0);
  }
  if (argv[0] !== "exec") {
    console.error("fake codex: unsupported invocation");
    return exit(2);
  }
  const step = nextStep(spec);
  // Codex exits 1 on SIGINT mid-turn without a terminal event (probed).
  if (step.mode === "hang") armInterrupt(step, () => exit(1));
  record(await stdin());
  return codexRun(step);
}

const readStdin = async (): Promise<string> => new Response(Bun.stdin.stream()).text();
const spec = scenario();
await (kind === "codex" ? codex(spec, readStdin) : claude(spec, readStdin));
