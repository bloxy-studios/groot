/**
 * Codex adapter — `codex exec --json` with the prompt on stdin (`-`), always
 * with explicit containment because the user's config can select
 * `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`:
 *
 *   codex exec --json --sandbox workspace-write -C <worktree>
 *              -c approval_policy="never" [--ignore-user-config] [-m M] -
 *
 * `--ignore-user-config` is passed only when `codex exec --help` lists it
 * (absent in 0.116). Resume puts every thread flag BEFORE the `resume`
 * subcommand (`… resume <thread_id> -`), as the official SDK does, because
 * `exec resume` itself has no --sandbox/-C. Codex has no turn or spend limit;
 * Groot enforces the wall time. Never passed: --dangerously-*, --yolo,
 * --full-auto.
 */
import { statSync } from "node:fs";
import { GrootV2Error } from "../errors.ts";
import { CodexStreamParser, classifyCodexText, codexNextStep } from "./codex-stream.ts";
import {
  assertSafeArg,
  buildCapabilities,
  errorInfo,
  flagBlock,
  notStartedResult,
  osSandbox,
  type ProbeResult,
  parseVersion,
  probe,
  startRun,
} from "./common.ts";
import { runnerEnv } from "./env.ts";
import { type ResolvedExecutable, resolveExecutable } from "./resolve.ts";
import type {
  RunnerAdapter,
  RunnerBlock,
  RunnerHandle,
  RunnerInvocation,
  RunnerPreflight,
} from "./types.ts";

export const CODEX_INTERFACE =
  'codex exec --json --sandbox workspace-write -C <worktree> -c approval_policy="never" - (prompt on stdin)';

export interface CodexFlags {
  readonly json: boolean;
  readonly sandbox: boolean;
  readonly ignoreUserConfig: boolean;
  readonly resume: boolean;
  readonly sandboxModes: readonly string[];
}

/** Feature-detect from `codex exec --help` (flags differ between versions). */
export function parseCodexHelp(help: string): CodexFlags {
  const modes = /\[possible values: ([^\]]+)\]/.exec(flagBlock(help, "--sandbox"))?.[1];
  return {
    json: /--json\b/.test(help),
    sandbox: /--sandbox\b/.test(help),
    ignoreUserConfig: /--ignore-user-config\b/.test(help),
    resume: /^\s+resume\b/m.test(help),
    sandboxModes: modes === undefined ? [] : modes.split(",").map((mode) => mode.trim()),
  };
}

const flagCache = new Map<string, Promise<CodexFlags>>();

/** `exec --help` once per executable build (keyed by path + mtime). */
async function codexFlags(path: string, env: Record<string, string>): Promise<CodexFlags> {
  let key = path;
  try {
    key = `${path}@${statSync(path).mtimeMs}`;
  } catch {
    // keep the path-only key
  }
  let cached = flagCache.get(key);
  if (cached === undefined) {
    cached = probe([path, "exec", "--help"], env).then((result) => parseCodexHelp(result.stdout));
    flagCache.set(key, cached);
  }
  return cached;
}

function assertCodexEffort(value: string): string {
  if (!/^[a-z]{2,16}$/.test(value)) {
    throw new GrootV2Error("GROOT_E_USAGE", `Invalid Codex reasoning effort "${value}".`);
  }
  return value;
}

/** Full argv (executable first) for a start or resume run. */
export function codexArgv(
  executable: string,
  invocation: RunnerInvocation,
  flags: Pick<CodexFlags, "ignoreUserConfig">,
): string[] {
  const resume = invocation.resumeSessionId ?? null;
  return [
    executable,
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    invocation.cwd,
    "-c",
    'approval_policy="never"',
    ...(flags.ignoreUserConfig ? ["--ignore-user-config"] : []),
    ...(invocation.model ? ["-m", assertSafeArg("model", invocation.model)] : []),
    ...(invocation.effort
      ? ["-c", `model_reasoning_effort="${assertCodexEffort(invocation.effort)}"`]
      : []),
    ...(resume === null ? [] : ["resume", assertSafeArg("thread id", resume)]),
    "-",
  ];
}

interface CodexAuth {
  readonly status: "authenticated" | "unauthenticated" | "unknown";
  readonly method: string | null;
  readonly detail: string;
  readonly block: RunnerBlock | null;
}

function upgradeHint(exe: ResolvedExecutable): string {
  return exe.extraEnv.CODEX_MANAGED_BY_BUN === "1"
    ? " (installed with bun: `bun install -g @openai/codex@latest`)"
    : "";
}

/**
 * `codex login status`: exit 0 = credentials present; exit 1 = not logged
 * in OR a config error — the text decides, config errors first.
 */
export function classifyCodexLogin(
  login: Pick<ProbeResult, "exitCode" | "stdout" | "stderr">,
  version: string | null,
  exe: ResolvedExecutable | null = null,
): CodexAuth {
  const text = `${login.stdout}\n${login.stderr}`.trim();
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (login.exitCode === 0) {
    const method = /chatgpt/i.test(text) ? "chatgpt" : /api key/i.test(text) ? "api-key" : null;
    return { status: "authenticated", method, detail: firstLine, block: null };
  }
  const found = classifyCodexText(text);
  if (found?.cause === "config-incompatible") {
    return {
      status: "unknown",
      method: null,
      detail: `codex-cli ${version ?? "?"} cannot load its configuration: ${found.detail}`,
      block: {
        cause: "config-incompatible",
        detail: `codex-cli ${version ?? "?"} cannot load its configuration: ${found.detail}`,
        nextStep: `${codexNextStep("config-incompatible")}${exe === null ? "" : ` Upgrade${upgradeHint(exe)}.`}`,
      },
    };
  }
  if (found !== null) {
    const status = found.cause === "unauthenticated" ? "unauthenticated" : "unknown";
    return {
      status,
      method: null,
      detail: found.detail,
      block: { cause: found.cause, detail: found.detail, nextStep: codexNextStep(found.cause) },
    };
  }
  return {
    status: "unknown",
    method: null,
    detail: `codex login status: ${firstLine}`,
    block: null,
  };
}

function notInstalled(notes: readonly string[]): RunnerPreflight {
  return {
    capabilities: buildCapabilities({
      runner: "codex",
      available: false,
      executable: null,
      version: null,
      interface: CODEX_INTERFACE,
      auth: { status: "unknown", method: null, detail: "Codex is not installed" },
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
      detail: notes.join("; ") || "codex not found",
      nextStep: "Install the Codex CLI or set GROOT_CODEX_PATH to its executable.",
    },
  };
}

function codexNotes(exe: ResolvedExecutable, flags: CodexFlags, version: string | null): string[] {
  return [
    `executable ${exe.path} (${exe.kind})`,
    ...(flags.ignoreUserConfig
      ? ["--ignore-user-config is supported: runs ignore the user's Codex config.toml"]
      : [
          `codex-cli ${version ?? "?"} has no --ignore-user-config: the user's Codex config (model, MCP servers, profiles) applies; Groot still passes --sandbox workspace-write and approval_policy="never" explicitly`,
        ]),
    "Codex has no turn or spend limit flag; Groot enforces the task wall time",
    "usage-limit (quota) exhaustion is only detectable during a run",
  ];
}

/** Discovery + the exact reason Codex cannot take work (if any). */
export async function preflightCodex(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunnerPreflight> {
  const resolution = resolveExecutable("codex", env);
  const exe = resolution.executable;
  if (exe === null) return notInstalled(resolution.notes);
  const childEnv = runnerEnv(env, "codex", { prependPath: exe.prependPath, extra: exe.extraEnv });
  const [versionProbe, helpProbe, loginProbe] = await Promise.all([
    probe([exe.path, "--version"], childEnv),
    probe([exe.path, "exec", "--help"], childEnv),
    probe([exe.path, "login", "status"], childEnv),
  ]);
  const version = parseVersion(`${versionProbe.stdout}\n${versionProbe.stderr}`);
  const flags = parseCodexHelp(helpProbe.stdout);
  const auth = classifyCodexLogin(loginProbe, version, exe);
  const incompatible: RunnerBlock | null =
    flags.json && flags.sandbox
      ? null
      : {
          cause: "incompatible",
          detail: `codex-cli ${version ?? "?"} exec lacks --json/--sandbox`,
          nextStep: `Upgrade the Codex CLI${upgradeHint(exe)}, then retry.`,
        };
  const block = incompatible ?? auth.block;
  return {
    capabilities: buildCapabilities({
      runner: "codex",
      available: block === null,
      executable: exe.path,
      version,
      interface: CODEX_INTERFACE,
      auth: { status: auth.status, method: auth.method, detail: auth.detail },
      features: {
        structuredEvents: flags.json,
        cancellation: "signal",
        resume: flags.resume,
        permissionModes: [...flags.sandboxModes],
        usage: "tokens",
        budgetLimit: false,
        turnLimit: false,
        sandbox: osSandbox(),
      },
      notes: [...codexNotes(exe, flags, version), ...resolution.notes],
    }),
    block,
  };
}

function startCodex(invocation: RunnerInvocation): RunnerHandle {
  const parser = new CodexStreamParser(invocation.limits.wallTimeMs);
  return startRun(
    invocation,
    async () => {
      const env = invocation.env ?? process.env;
      const resolution = resolveExecutable("codex", env);
      const exe = resolution.executable;
      if (exe === null) {
        return notStartedResult(
          "failed",
          errorInfo("GROOT_E_RUNNER_UNAVAILABLE", "Codex executable not found.", {
            hint: "Install the Codex CLI or set GROOT_CODEX_PATH.",
            details: { notes: resolution.notes },
          }),
          resolution.notes,
        );
      }
      const childEnv = runnerEnv(env, "codex", {
        prependPath: exe.prependPath,
        extra: exe.extraEnv,
      });
      const flags = await codexFlags(exe.path, childEnv);
      return {
        argv: codexArgv(exe.path, invocation, flags),
        env: childEnv,
        notes: [`executable ${exe.path}`, ...resolution.notes],
      };
    },
    parser,
  );
}

export const codexAdapter: RunnerAdapter = {
  id: "codex",
  async discover(env) {
    return (await preflightCodex(env)).capabilities;
  },
  preflight: (env) => preflightCodex(env),
  start: startCodex,
};
