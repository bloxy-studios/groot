/**
 * Installed-agent runners (docs/v2-architecture.md#agent-runners-and-tasks):
 * the adapter registry and truthful discovery. Surfaces (CLI, MCP, tasks)
 * import from here only.
 */
import type { RunnerCapabilities, RunnerId } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { assertClaudeEffort, claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import type { RunnerAdapter } from "./types.ts";

const ADAPTERS: Readonly<Record<RunnerId, RunnerAdapter>> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
};

export function getRunner(id: RunnerId): RunnerAdapter {
  const adapter = ADAPTERS[id];
  if (adapter === undefined) {
    throw new GrootV2Error("GROOT_E_USAGE", `Unknown runner "${String(id)}".`, {
      hint: `Use one of: ${Object.keys(ADAPTERS).join(", ")}.`,
    });
  }
  return adapter;
}

/**
 * Validate a reasoning effort for a runner BEFORE any work is claimed (an
 * invalid value would otherwise surface only when argv is built).
 */
export function assertEffort(runner: RunnerId, effort: string): string {
  if (runner === "claude-code") return assertClaudeEffort(effort);
  if (!/^[a-z]{2,16}$/.test(effort)) {
    throw new GrootV2Error("GROOT_E_USAGE", `Invalid Codex reasoning effort "${effort}".`);
  }
  return effort;
}

/** Discover every supported runner (in parallel); each result is contract-validated. */
export async function discoverRunners(
  env: Record<string, string | undefined> = process.env,
): Promise<RunnerCapabilities[]> {
  return Promise.all(Object.values(ADAPTERS).map((adapter) => adapter.discover(env)));
}

export { CLAUDE_INTERFACE } from "./claude.ts";
export { CODEX_INTERFACE } from "./codex.ts";
export { logShowsSession } from "./common.ts";
export {
  credentialFreeEnv,
  knownSecretsFromEnv,
  runnerEnv,
  SCRUBBED_ENV,
  SCRUBBED_ENV_PREFIXES,
} from "./env.ts";
export { inspectRunnerGroup, type RunnerGroupRecord, stopRunnerGroup } from "./groups.ts";
export { resolveExecutable } from "./resolve.ts";
export type {
  AttemptStatus,
  CancelGrace,
  RunnerAdapter,
  RunnerBlock,
  RunnerBlockCause,
  RunnerEvent,
  RunnerHandle,
  RunnerInvocation,
  RunnerLimits,
  RunnerPreflight,
  RunnerResult,
} from "./types.ts";
