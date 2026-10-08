/**
 * Claude Code stream-json parsing and outcome classification
 * (`claude -p --output-format stream-json --verbose`).
 *
 * Rules learned from the documented schema and local probes:
 * - Ignore unknown event types; this build emits an undocumented
 *   `system/ui_invalidate` before `system/init`.
 * - `system/init` carries model, permissionMode, claude_code_version, session_id.
 * - The final `result` decides the outcome through `is_error` +
 *   `terminal_reason` — an API 404 arrives as `subtype: "success"` with
 *   `is_error: true`, so `subtype` alone is never trusted.
 * - `total_cost_usd` is Claude Code's client-side ESTIMATE (and cumulative
 *   across a resumed session); it is labelled as such in usage.source.
 * - A run can end with no `result` at all (SIGINT while a tool starts, an
 *   unknown `--resume` target: "No conversation found", a sandbox that
 *   cannot start under `failIfUnavailable`).
 * - `system/init` lists the tools the session really has; anything beyond
 *   Groot's `--tools` list is recorded as a warning note.
 */
import type { ErrorId, ErrorInfo } from "../contracts/envelope.ts";
import type { UsageReport } from "../contracts/task.ts";
import { redact } from "../redact.ts";
import {
  asNumber,
  asRecord,
  asString,
  errorInfo,
  event,
  exitNotes,
  type StreamParser,
  truncate,
  unavailableUsage,
} from "./common.ts";
import type { SupervisedExit } from "./supervise.ts";
import type { AttemptStatus, RunnerEvent, RunnerResult } from "./types.ts";

const FINAL_MESSAGE_CAP = 4000;

export interface ClaudeFinal {
  readonly subtype: string | null;
  readonly isError: boolean | null;
  readonly terminalReason: string | null;
  readonly apiErrorStatus: number | null;
  readonly totalCostUsd: number | null;
  readonly numTurns: number | null;
  readonly result: string | null;
  readonly errors: readonly string[];
  readonly modelUsage: Record<string, unknown> | null;
  readonly usage: Record<string, unknown> | null;
}

export interface ClaudeClassifyContext {
  readonly model: string | null;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number | null;
  readonly wallTimeMs: number;
  /** The `--tools` list Groot passed (init-reported extras become a warning). */
  readonly tools?: readonly string[];
}

interface Outcome {
  readonly status: AttemptStatus;
  readonly error: ErrorInfo | null;
}

function parseFinal(doc: Record<string, unknown>): ClaudeFinal {
  const errors = Array.isArray(doc.errors)
    ? doc.errors.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    : [];
  return {
    subtype: asString(doc.subtype),
    isError: typeof doc.is_error === "boolean" ? doc.is_error : null,
    terminalReason: asString(doc.terminal_reason),
    apiErrorStatus: asNumber(doc.api_error_status),
    totalCostUsd: asNumber(doc.total_cost_usd),
    numTurns: asNumber(doc.num_turns),
    result: asString(doc.result),
    errors,
    modelUsage: asRecord(doc.modelUsage),
    usage: asRecord(doc.usage),
  };
}

function toolSummary(block: Record<string, unknown>): string {
  const name = asString(block.name) ?? "tool";
  const input = asRecord(block.input) ?? {};
  const target =
    asString(input.command) ??
    asString(input.file_path) ??
    asString(input.path) ??
    asString(input.pattern) ??
    "";
  return `${name} ${target}`.trim();
}

/** Stateful line parser for one Claude run. */
export class ClaudeStreamParser implements StreamParser {
  sessionId: string | null = null;
  model: string | null = null;
  version: string | null = null;
  permissionMode: string | null = null;
  simulated = false;
  lastText: string | null = null;
  apiError: string | null = null;
  final: ClaudeFinal | null = null;
  /** Tools `system/init` reported (null until init). */
  tools: string[] | null = null;

  constructor(private readonly context: ClaudeClassifyContext) {}

  line(raw: string): RunnerEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return event("unknown", "text", raw);
    }
    const doc = asRecord(parsed);
    if (doc === null) return event("unknown", "json", raw);
    const type = asString(doc.type) ?? "unknown";
    if (doc.simulated === true) this.simulated = true;
    switch (type) {
      case "system":
        return this.system(doc);
      case "assistant":
        return this.assistant(doc);
      case "user":
        return event("tool", "user", "tool result");
      case "result":
        this.final = parseFinal(doc);
        this.sessionId = asString(doc.session_id) ?? this.sessionId;
        return event(
          "result",
          "result",
          `${this.final.subtype ?? "?"} · is_error=${String(this.final.isError)} · terminal_reason=${this.final.terminalReason ?? "?"}`,
        );
      default:
        return event("unknown", type, type);
    }
  }

  private system(doc: Record<string, unknown>): RunnerEvent {
    const subtype = asString(doc.subtype) ?? "unknown";
    if (subtype !== "init") return event("notice", `system/${subtype}`, subtype);
    this.sessionId = asString(doc.session_id) ?? this.sessionId;
    this.model = asString(doc.model);
    this.version = asString(doc.claude_code_version);
    this.permissionMode = asString(doc.permissionMode);
    if (Array.isArray(doc.tools)) {
      this.tools = doc.tools.filter((tool): tool is string => typeof tool === "string");
    }
    return event(
      "session",
      "system/init",
      `session ${this.sessionId ?? "?"} · ${this.model ?? "?"} · Claude Code ${this.version ?? "?"} · ${this.permissionMode ?? "?"}`,
    );
  }

  private assistant(doc: Record<string, unknown>): RunnerEvent {
    const error = asString(doc.error);
    if (error !== null) this.apiError = error;
    const content = asRecord(doc.message)?.content;
    const blocks = Array.isArray(content) ? content.map(asRecord).filter((b) => b !== null) : [];
    const tools = blocks.filter((block) => block.type === "tool_use");
    const texts = blocks
      .filter((block) => block.type === "text")
      .map((block) => asString(block.text) ?? "")
      .filter((text) => text.trim() !== "");
    if (texts.length > 0) this.lastText = texts.join("\n");
    if (error !== null) return event("notice", "assistant/error", `API error: ${error}`);
    if (tools.length > 0) {
      return event(
        "tool",
        "assistant/tool_use",
        tools.map((block) => toolSummary(block)).join("; "),
      );
    }
    return event("message", "assistant", texts.join(" ") || "(thinking)");
  }

  finish(exit: SupervisedExit): RunnerResult {
    return classifyClaude(this, exit, this.context);
  }
}

interface TokenTotals {
  input: number;
  output: number;
  cached: number;
}

const count = (value: unknown): number => Math.max(0, Math.round(asNumber(value) ?? 0));

function tokenTotals(final: ClaudeFinal): TokenTotals | null {
  const models = Object.values(final.modelUsage ?? {})
    .map(asRecord)
    .filter((entry) => entry !== null);
  if (models.length > 0) {
    return models.reduce<TokenTotals>(
      (sum, entry) => ({
        input:
          sum.input +
          count(entry.inputTokens) +
          count(entry.cacheReadInputTokens) +
          count(entry.cacheCreationInputTokens),
        output: sum.output + count(entry.outputTokens),
        cached: sum.cached + count(entry.cacheReadInputTokens),
      }),
      { input: 0, output: 0, cached: 0 },
    );
  }
  const usage = final.usage;
  if (usage === null) return null;
  return {
    input:
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
    cached: count(usage.cache_read_input_tokens),
  };
}

function modelLabels(final: ClaudeFinal): string {
  const labels = Object.entries(final.modelUsage ?? {}).map(([name, value]) => {
    const entry = asRecord(value) ?? {};
    const basis = [asString(entry.provider), asString(entry.costBasis)].filter(Boolean).join(", ");
    return basis === "" ? name : `${name} (${basis})`;
  });
  return labels.length === 0 ? "" : `; models: ${labels.join(", ")}`;
}

/** Usage from the final result; cost is labelled as Claude Code's own estimate. */
export function claudeUsage(final: ClaudeFinal | null, durationMs: number): UsageReport {
  if (final === null) {
    return unavailableUsage(
      durationMs,
      "claude-code: no final result event (cancelled or crashed) — usage unknown",
    );
  }
  const totals = tokenTotals(final);
  const cost = final.totalCostUsd;
  return {
    kind: cost !== null ? "observed-cost" : totals !== null ? "tokens" : "unavailable",
    costUsd: cost === null ? null : Math.max(0, cost),
    inputTokens: totals?.input ?? null,
    outputTokens: totals?.output ?? null,
    cachedInputTokens: totals?.cached ?? null,
    turns: final.numTurns === null ? null : count(final.numTurns),
    durationMs: Math.max(0, Math.round(durationMs)),
    source: `claude-code result.total_cost_usd — Claude Code's client-side ESTIMATE, not a bill (cumulative across a resumed session); tokens include cache reads/writes${modelLabels(final)}`,
  };
}

interface ApiErrorClass {
  readonly id: ErrorId;
  readonly cause: string;
  readonly hint: string;
}

const API_ERRORS: Readonly<Record<string, ApiErrorClass>> = {
  model_not_found: {
    id: "GROOT_E_RUNNER_UNAVAILABLE",
    cause: "model-unavailable",
    hint: "Pick a model your provider serves (aliases are provider-dependent), e.g. --model opus.",
  },
  authentication_failed: {
    id: "GROOT_E_BLOCKED",
    cause: "unauthenticated",
    hint: "Run `claude auth login` (or fix the provider credentials), then retry.",
  },
  oauth_org_not_allowed: {
    id: "GROOT_E_BLOCKED",
    cause: "unauthenticated",
    hint: "This organization is not allowed for the logged-in account; log in with another one.",
  },
  account_on_hold: {
    id: "GROOT_E_BLOCKED",
    cause: "unauthenticated",
    hint: "The account is on hold; resolve it with the provider, then retry.",
  },
  cloud_credential_error: {
    id: "GROOT_E_BLOCKED",
    cause: "unauthenticated",
    hint: "Refresh the cloud provider credentials Claude Code uses, then retry.",
  },
  billing_error: {
    id: "GROOT_E_BLOCKED",
    cause: "quota",
    hint: "Check the account's billing or credits, then retry.",
  },
  rate_limit: {
    id: "GROOT_E_RUNNER_UNAVAILABLE",
    cause: "rate-limited",
    hint: "Wait for the rate limit to reset, then resume the task.",
  },
  overloaded: {
    id: "GROOT_E_RUNNER_UNAVAILABLE",
    cause: "overloaded",
    hint: "The provider is overloaded; resume the task later.",
  },
  server_error: {
    id: "GROOT_E_RUNNER_UNAVAILABLE",
    cause: "server-error",
    hint: "The provider returned a server error; resume the task later.",
  },
};

function apiErrorOutcome(
  apiError: string,
  final: ClaudeFinal,
  context: ClaudeClassifyContext,
  model: string | null,
): Outcome {
  const known = API_ERRORS[apiError];
  const status = final.apiErrorStatus === null ? "" : ` (HTTP ${final.apiErrorStatus})`;
  const subject =
    apiError === "model_not_found"
      ? `Model "${context.model ?? model ?? "default"}" is not available on this provider${status}.`
      : `Claude Code API error "${apiError}"${status}.`;
  return {
    status: "failed",
    error: errorInfo(known?.id ?? "GROOT_E_COMMAND_FAILED", subject, {
      hint: known?.hint ?? "See the attempt log for the provider's message.",
      details: {
        cause: known?.cause ?? "api-error",
        apiError,
        httpStatus: final.apiErrorStatus,
        terminalReason: final.terminalReason,
      },
    }),
  };
}

const SANDBOX_UNAVAILABLE = /sandbox required but unavailable/i;
const SESSION_NOT_FOUND = /no conversation found/i;

/** Claude Code refused to start without its OS sandbox (Groot sets failIfUnavailable). */
function sandboxUnavailable(text: string): Outcome {
  const line =
    text.split("\n").find((entry) => SANDBOX_UNAVAILABLE.test(entry)) ?? "sandbox unavailable";
  return {
    status: "failed",
    error: errorInfo(
      "GROOT_E_BLOCKED",
      `Claude Code's OS sandbox could not start: ${truncate(line, 300)}`,
      {
        hint: "Install what the message names (on Linux: bubblewrap and socat), then retry — Groot never lets Claude Code run Bash unsandboxed.",
        details: { cause: "sandbox-unavailable" },
      },
    ),
  };
}

/** A `--resume` target Claude Code has no conversation for (it never started, or was purged). */
function sessionNotFound(text: string): Outcome {
  return {
    status: "failed",
    error: errorInfo(
      "GROOT_E_NOT_RESUMABLE",
      `Claude Code has no conversation to resume: ${truncate(text, 300)}`,
      {
        hint: "Groot starts a fresh session with the task prompt instead.",
        details: { cause: "session-not-found" },
      },
    ),
  };
}

function noResultOutcome(exit: SupervisedExit): Outcome {
  const tail = truncate(exit.stderrTail, 400);
  if (SANDBOX_UNAVAILABLE.test(exit.stderrTail)) return sandboxUnavailable(exit.stderrTail);
  if (SESSION_NOT_FOUND.test(tail)) return sessionNotFound(tail);
  if (/requires --verbose|unknown option|error: option|invalid choice|is not a valid/i.test(tail)) {
    return {
      status: "failed",
      error: errorInfo(
        "GROOT_E_RUNNER_UNAVAILABLE",
        `Claude Code rejected Groot's flags: ${tail}`,
        {
          hint: "Upgrade Claude Code (`claude update`); Groot never runs it without containment flags.",
          details: { cause: "incompatible" },
        },
      ),
    };
  }
  if (/not logged in|run \/login|claude auth login/i.test(tail)) {
    return {
      status: "failed",
      error: errorInfo("GROOT_E_BLOCKED", `Claude Code is not authenticated: ${tail}`, {
        hint: "Run `claude auth login`, then retry.",
        details: { cause: "unauthenticated" },
      }),
    };
  }
  return {
    status: "failed",
    error: errorInfo(
      "GROOT_E_COMMAND_FAILED",
      `Claude Code exited (${exit.exitCode ?? exit.signal ?? "?"}) without a final result${tail === "" ? "." : `: ${tail}`}`,
      { details: { cause: "no-result" } },
    ),
  };
}

function isCleanSuccess(final: ClaudeFinal, exit: SupervisedExit): boolean {
  return (
    final.isError === false &&
    final.subtype === "success" &&
    (final.terminalReason === null || final.terminalReason === "completed") &&
    exit.exitCode === 0
  );
}

/** Outcomes decided by how the process ended, whatever it printed (null: look at the stream). */
function exitOutcome(exit: SupervisedExit, context: ClaudeClassifyContext): Outcome | null {
  if (exit.spawnError !== null) {
    return {
      status: "failed",
      error: errorInfo(
        "GROOT_E_RUNNER_UNAVAILABLE",
        `Could not start Claude Code: ${exit.spawnError}`,
      ),
    };
  }
  if (exit.cancelled) {
    return {
      status: "interrupted",
      error: errorInfo("GROOT_E_INTERRUPTED", "The run was cancelled; its session can be resumed."),
    };
  }
  if (exit.timedOut) {
    return {
      status: "timed-out",
      error: errorInfo(
        "GROOT_E_COMMAND_FAILED",
        `Wall time of ${Math.round(context.wallTimeMs / 1000)} s exceeded; the runner was stopped.`,
        { details: { cause: "wall-time" } },
      ),
    };
  }
  return null;
}

function claudeOutcome(
  state: ClaudeStreamParser,
  exit: SupervisedExit,
  context: ClaudeClassifyContext,
): Outcome {
  const ended = exitOutcome(exit, context);
  if (ended !== null) return ended;
  const final = state.final;
  if (final === null) return noResultOutcome(exit);
  if (isCleanSuccess(final, exit)) return { status: "succeeded", error: null };
  const reported = [...final.errors, exit.stderrTail].join("\n");
  if (SANDBOX_UNAVAILABLE.test(reported)) return sandboxUnavailable(reported);
  if (final.subtype === "error_max_budget_usd" || final.terminalReason === "budget_exhausted") {
    return {
      status: "budget-exceeded",
      error: errorInfo(
        "GROOT_E_COMMAND_FAILED",
        `Spend limit reached (--max-budget-usd ${context.maxBudgetUsd ?? "?"}, Claude Code's estimate).`,
        { details: { cause: "max-budget" } },
      ),
    };
  }
  if (final.subtype === "error_max_turns" || final.terminalReason === "max_turns") {
    return {
      status: "failed",
      error: errorInfo(
        "GROOT_E_COMMAND_FAILED",
        `Turn limit reached (--max-turns ${context.maxTurns}).`,
        {
          details: { cause: "max-turns" },
        },
      ),
    };
  }
  const apiError = state.apiError ?? (final.terminalReason === "api_error" ? "api_error" : null);
  if (apiError !== null) return apiErrorOutcome(apiError, final, context, state.model);
  const errors = final.errors.length === 0 ? "" : `: ${truncate(final.errors.join("; "), 300)}`;
  return {
    status: "failed",
    error: errorInfo(
      "GROOT_E_COMMAND_FAILED",
      `Claude Code reported failure (subtype ${final.subtype ?? "?"}, is_error ${String(final.isError)}, terminal_reason ${final.terminalReason ?? "?"}, exit ${exit.exitCode ?? exit.signal ?? "?"})${errors}`,
      { details: { cause: "runner-error", terminalReason: final.terminalReason } },
    ),
  };
}

function runNotes(state: ClaudeStreamParser, context: ClaudeClassifyContext): string[] {
  const notes: string[] = [];
  if (state.version !== null) notes.push(`Claude Code ${state.version}`);
  if (state.model !== null) notes.push(`model ${state.model}`);
  if (state.permissionMode !== null && state.permissionMode !== "acceptEdits") {
    notes.push(
      `WARNING: runner reported permission mode ${state.permissionMode} (Groot passed acceptEdits)`,
    );
  }
  const allowed = context.tools;
  const extra =
    allowed === undefined ? [] : (state.tools ?? []).filter((tool) => !allowed.includes(tool));
  if (extra.length > 0) {
    notes.push(
      `WARNING: Claude Code exposed tools beyond Groot's --tools list: ${truncate(extra.join(", "), 300)}`,
    );
  }
  if (state.simulated) notes.push("simulated runner (test double) — not live evidence");
  return notes;
}

/** Classify a finished Claude run into the RunnerResult contract. */
export function classifyClaude(
  state: ClaudeStreamParser,
  exit: SupervisedExit,
  context: ClaudeClassifyContext,
): RunnerResult {
  const outcome = claudeOutcome(state, exit, context);
  const message = state.final?.result ?? state.lastText;
  return {
    status: outcome.status,
    error: outcome.error,
    sessionId: state.sessionId,
    exitCode: exit.exitCode,
    usage: claudeUsage(state.final, exit.durationMs),
    finalMessage: message === null ? null : redact(message).slice(0, FINAL_MESSAGE_CAP),
    simulated: state.simulated,
    notes: [...runNotes(state, context), ...exitNotes(exit)],
  };
}
