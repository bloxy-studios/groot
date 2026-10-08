/**
 * Claude Code adapter — `claude -p --output-format stream-json --verbose`
 * with explicit containment on EVERY run (start and resume), because user
 * defaults can be hazardous (e.g. `permissions.defaultMode:
 * bypassPermissions`), and headless defaults differ by provider:
 *
 *   --permission-mode acceptEdits     file edits inside the worktree only
 *   --permission-prompts none         anything that would prompt is denied
 *   --strict-mcp-config               no MCP servers (none are passed)
 *   --max-turns / --max-budget-usd    bounded spend
 *   --allowedTools / --disallowedTools  read/edit tools + the acceptance
 *                                     commands; never push, web fetch, search
 *   --settings {"sandbox":…}          OS sandbox for Bash, no escape hatch
 *
 * Never passed: --dangerously-*, bypassPermissions, --bare (it would break
 * subscription and keychain auth). The prompt goes to stdin; the task rules
 * go to --append-system-prompt. Resume re-passes every flag with
 * `--resume <id>` instead of `--session-id`.
 */
import { GrootV2Error } from "../errors.ts";
import { ClaudeStreamParser } from "./claude-stream.ts";
import {
  assertSafeArg,
  buildCapabilities,
  errorInfo,
  flagBlock,
  isRuleSafeCommand,
  notStartedResult,
  osSandbox,
  parseVersion,
  probe,
  startRun,
} from "./common.ts";
import { runnerEnv } from "./env.ts";
import { resolveExecutable } from "./resolve.ts";
import type {
  RunnerAdapter,
  RunnerBlock,
  RunnerHandle,
  RunnerInvocation,
  RunnerPreflight,
} from "./types.ts";

export const CLAUDE_INTERFACE = "claude -p --output-format stream-json --verbose (prompt on stdin)";
export const CLAUDE_BASE_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep"];
export const CLAUDE_DENIED_TOOLS: readonly string[] = [
  "Bash(git push *)",
  "Bash(git commit *)",
  "WebFetch",
  "WebSearch",
];
export const CLAUDE_SANDBOX_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
});
export const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Flags Groot's containment depends on — a Claude Code without them is refused. */
const REQUIRED_FLAGS = [
  "--output-format",
  "--verbose",
  "--session-id",
  "--resume",
  "--permission-mode",
  "--permission-prompts",
  "--strict-mcp-config",
  "--allowedTools",
  "--disallowedTools",
  "--settings",
  "--append-system-prompt",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new GrootV2Error("GROOT_E_USAGE", `Claude session ids must be UUIDs (got "${value}").`);
  }
  return value;
}

export function assertClaudeEffort(value: string): string {
  if (!CLAUDE_EFFORTS.includes(value)) {
    throw new GrootV2Error("GROOT_E_USAGE", `Unknown Claude effort "${value}".`, {
      hint: `Use one of: ${CLAUDE_EFFORTS.join(", ")}.`,
    });
  }
  return value;
}

/** `Bash(<cmd>)` + `Bash(<cmd> *)` allow rules for the commands a task may run. */
export function bashRules(commands: readonly string[]): string[] {
  const rules = commands
    .map((command) => command.trim())
    .filter((command) => command !== "" && isRuleSafeCommand(command))
    .flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]);
  return [...new Set(rules)];
}

/** Full argv (executable first) for a start or resume run. */
export function claudeArgv(executable: string, invocation: RunnerInvocation): string[] {
  const resume = invocation.resumeSessionId ?? null;
  const session =
    resume !== null
      ? ["--resume", assertSafeArg("session id", resume)]
      : ["--session-id", assertUuid(invocation.sessionId)];
  const { limits } = invocation;
  return [
    executable,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...session,
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--max-turns",
    String(limits.maxTurns),
    ...(limits.maxBudgetUsd === null ? [] : ["--max-budget-usd", String(limits.maxBudgetUsd)]),
    ...(invocation.model ? ["--model", assertSafeArg("model", invocation.model)] : []),
    ...(invocation.effort ? ["--effort", assertClaudeEffort(invocation.effort)] : []),
    "--allowedTools",
    ...CLAUDE_BASE_TOOLS,
    ...bashRules(invocation.allowedCommands),
    "--disallowedTools",
    ...CLAUDE_DENIED_TOOLS,
    "--settings",
    CLAUDE_SANDBOX_SETTINGS,
    ...(invocation.systemPrompt ? ["--append-system-prompt", invocation.systemPrompt] : []),
  ];
}

interface AuthProbe {
  readonly status: "authenticated" | "unauthenticated" | "unknown";
  readonly method: string | null;
  readonly detail: string;
}

/** `claude auth status` prints JSON and exits 0 (logged in) or 1 (not). */
export function parseClaudeAuth(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): AuthProbe {
  try {
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    const method = typeof doc.authMethod === "string" ? doc.authMethod : null;
    const provider = typeof doc.apiProvider === "string" ? doc.apiProvider : null;
    const label = [method, provider === null ? null : `provider ${provider}`]
      .filter(Boolean)
      .join(", ");
    if (doc.loggedIn === true && exitCode === 0) {
      return { status: "authenticated", method, detail: `logged in (${label})` };
    }
    if (doc.loggedIn === false || exitCode === 1) {
      return {
        status: "unauthenticated",
        method,
        detail: `not logged in (${label || "no method"})`,
      };
    }
  } catch {
    // fall through: unparseable output
  }
  const text = `${stdout}\n${stderr}`.trim().split("\n").slice(-2).join(" ");
  return {
    status: "unknown",
    method: null,
    detail: `claude auth status was inconclusive: ${text}`,
  };
}

/** Choices listed for --permission-mode (empty when the help does not list them). */
export function permissionModes(help: string): string[] {
  const choices = /\(choices:([^)]*)\)/.exec(flagBlock(help, "--permission-mode"))?.[1];
  if (choices === undefined) return [];
  return [...choices.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
}

function notInstalled(notes: readonly string[]): RunnerPreflight {
  return {
    capabilities: buildCapabilities({
      runner: "claude-code",
      available: false,
      executable: null,
      version: null,
      interface: CLAUDE_INTERFACE,
      auth: { status: "unknown", method: null, detail: "Claude Code is not installed" },
      features: {
        structuredEvents: false,
        cancellation: "none",
        resume: false,
        permissionModes: [],
        usage: "none",
        budgetLimit: false,
        turnLimit: false,
        sandbox: "none",
      },
      notes: [...notes],
    }),
    block: {
      cause: "not-installed",
      detail: notes.join("; ") || "claude not found",
      nextStep:
        "Install Claude Code (https://code.claude.com/docs) or set GROOT_CLAUDE_PATH to its executable.",
    },
  };
}

function blockFor(
  missing: readonly string[],
  version: string | null,
  auth: AuthProbe,
): RunnerBlock | null {
  if (missing.length > 0) {
    return {
      cause: "incompatible",
      detail: `Claude Code ${version ?? "(unknown version)"} lacks ${missing.join(", ")}, which Groot's containment requires`,
      nextStep: "Upgrade Claude Code (`claude update`), then retry.",
    };
  }
  if (auth.status === "unauthenticated") {
    return {
      cause: "unauthenticated",
      detail: `claude auth status: ${auth.detail}`,
      nextStep: "Run `claude auth login` (or configure your API provider), then retry.",
    };
  }
  return null;
}

/** Discovery + the exact reason Claude Code cannot take work (if any). */
export async function preflightClaude(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunnerPreflight> {
  const resolution = resolveExecutable("claude-code", env);
  const exe = resolution.executable;
  if (exe === null) return notInstalled(resolution.notes);
  const childEnv = runnerEnv(env, "claude-code", {
    prependPath: exe.prependPath,
    extra: exe.extraEnv,
  });
  const [versionProbe, helpProbe, authProbe] = await Promise.all([
    probe([exe.path, "--version"], childEnv),
    probe([exe.path, "--help"], childEnv),
    probe([exe.path, "auth", "status"], childEnv),
  ]);
  const version = parseVersion(versionProbe.stdout);
  const help = helpProbe.stdout;
  const missing = REQUIRED_FLAGS.filter((flag) => !help.includes(flag));
  const auth = parseClaudeAuth(authProbe.exitCode, authProbe.stdout, authProbe.stderr);
  const block = blockFor(missing, version, auth);
  const notes = [
    `executable ${exe.path} (${exe.kind})`,
    ...resolution.notes,
    "--max-turns is documented but hidden from --help; Groot passes it on every run",
    "usage cost is Claude Code's client-side estimate (total_cost_usd), not billing",
    ...(auth.status === "unknown" ? [auth.detail] : []),
  ];
  return {
    capabilities: buildCapabilities({
      runner: "claude-code",
      available: block === null,
      executable: exe.path,
      version,
      interface: CLAUDE_INTERFACE,
      auth: { status: auth.status, method: auth.method, detail: auth.detail },
      features: {
        structuredEvents: help.includes("stream-json"),
        cancellation: "signal",
        resume: help.includes("--resume"),
        permissionModes: permissionModes(help),
        usage: "observed-cost",
        budgetLimit: help.includes("--max-budget-usd"),
        turnLimit: true,
        sandbox: osSandbox(),
      },
      notes,
    }),
    block,
  };
}

function startClaude(invocation: RunnerInvocation): RunnerHandle {
  const parser = new ClaudeStreamParser({
    model: invocation.model ?? null,
    maxTurns: invocation.limits.maxTurns,
    maxBudgetUsd: invocation.limits.maxBudgetUsd,
    wallTimeMs: invocation.limits.wallTimeMs,
  });
  return startRun(
    invocation,
    async () => {
      const env = invocation.env ?? process.env;
      const resolution = resolveExecutable("claude-code", env);
      const exe = resolution.executable;
      if (exe === null) {
        return notStartedResult(
          "failed",
          errorInfo("GROOT_E_RUNNER_UNAVAILABLE", "Claude Code executable not found.", {
            hint: "Install Claude Code or set GROOT_CLAUDE_PATH.",
            details: { notes: resolution.notes },
          }),
          resolution.notes,
        );
      }
      return {
        argv: claudeArgv(exe.path, invocation),
        env: runnerEnv(env, "claude-code", { prependPath: exe.prependPath, extra: exe.extraEnv }),
        notes: [`executable ${exe.path}`, ...resolution.notes],
      };
    },
    parser,
  );
}

export const claudeAdapter: RunnerAdapter = {
  id: "claude-code",
  async discover(env) {
    return (await preflightClaude(env)).capabilities;
  },
  preflight: (env) => preflightClaude(env),
  start: startClaude,
};
