/**
 * Child environment for runner processes. Groot itself often runs inside a
 * Claude Code session (or a terminal multiplexer that wraps agents); those
 * inherited variables would mark the child as a nested session, raise its
 * effort, inject Node preload modules, or re-activate wrapper shims. They are
 * removed. Provider selectors (CLAUDE_CODE_USE_FOUNDRY, ANTHROPIC_*, OPENAI_*)
 * are kept — Groot reuses each tool's own login and never reads credentials.
 */
import type { RunnerId } from "../contracts/task.ts";

/** Exact names scrubbed from every runner child. */
export const SCRUBBED_ENV: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "NODE_OPTIONS",
];

/** Name prefixes scrubbed from every runner child. */
export const SCRUBBED_ENV_PREFIXES: readonly string[] = ["CLAUDE_CODE_MESSAGING_", "CMUX_"];

export function isScrubbed(name: string): boolean {
  return (
    SCRUBBED_ENV.includes(name) || SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Set for Claude runs: bounded runs never background work or self-update mid-task. */
const CLAUDE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  DISABLE_AUTOUPDATER: "1",
};

export interface RunnerEnvOptions {
  /** Directories to prepend to PATH (Codex's bundled tools when spawning its native binary). */
  readonly prependPath?: readonly string[];
  /** Extra variables the launcher would have set (e.g. CODEX_MANAGED_BY_BUN). */
  readonly extra?: Readonly<Record<string, string>>;
}

/** The scrubbed environment a runner child receives. */
export function runnerEnv(
  base: Readonly<Record<string, string | undefined>>,
  runner: RunnerId,
  options: RunnerEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isScrubbed(name)) continue;
    env[name] = value;
  }
  const prepend = options.prependPath ?? [];
  if (prepend.length > 0) {
    env.PATH = [...prepend, ...(env.PATH ?? "").split(":").filter(Boolean)].join(":");
  }
  return {
    ...env,
    ...(options.extra ?? {}),
    ...(runner === "claude-code" ? CLAUDE_ENV : {}),
  };
}

const SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL|PRIVATE)/i;

/**
 * Values of sensitive-looking variables, redacted exactly from runner logs —
 * an agent that echoes its environment must not leak a provider token into
 * `.groot/tasks/<id>/attempt-<n>.jsonl`.
 */
export function knownSecretsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) => value !== undefined && value.length >= 8 && SENSITIVE_NAME.test(name),
    )
    .map(([, value]) => value as string);
}
