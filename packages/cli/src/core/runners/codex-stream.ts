/**
 * Codex `exec --json` JSONL parsing and outcome classification.
 *
 * Events (codex-sdk ThreadEvent): `thread.started {thread_id}` (the resume
 * handle), `turn.started`, `item.started|updated|completed {item}`,
 * `turn.completed {usage}` (tokens only — Codex reports no cost; fields vary
 * by version, so every count is optional), `turn.failed {error}`, and
 * top-level `error {message}`, which is ALSO used for non-fatal retry notices
 * ("Reconnecting... 2/5") and therefore never ends a run by itself.
 *
 * Exit facts (probed): a config the CLI cannot parse exits 1 with stderr and
 * no JSONL; SIGINT exits 1 with no terminal event; usage-limit and auth
 * failures arrive as `turn.failed`.
 */
import type { ErrorInfo } from "../contracts/envelope.ts";
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
import type { AttemptStatus, RunnerBlockCause, RunnerEvent, RunnerResult } from "./types.ts";

const FINAL_MESSAGE_CAP = 4000;

export interface CodexTextClass {
  readonly cause: Extract<RunnerBlockCause, "config-incompatible" | "quota" | "unauthenticated">;
  readonly detail: string;
}

const QUOTA = /usage limit|hit your usage limit|quota|insufficient_quota|purchase more credits/i;
const UNAUTHENTICATED =
  /not logged in|401 unauthorized|unauthorized|invalid api key|authentication required/i;
const CONFIG = /error loading config/i;

function matchingLine(text: string, pattern: RegExp): string {
  return (text.split("\n").find((line) => pattern.test(line)) ?? text).trim();
}

/**
 * Classify Codex error text (stderr, `login status`, `turn.failed`) into a
 * blocked cause — config incompatibility first, because a broken config also
 * makes `login status` exit 1 like a logged-out install.
 */
export function classifyCodexText(text: string): CodexTextClass | null {
  if (CONFIG.test(text))
    return { cause: "config-incompatible", detail: matchingLine(text, CONFIG) };
  if (QUOTA.test(text)) return { cause: "quota", detail: matchingLine(text, QUOTA) };
  if (UNAUTHENTICATED.test(text)) {
    return { cause: "unauthenticated", detail: matchingLine(text, UNAUTHENTICATED) };
  }
  return null;
}

const NEXT_STEP: Record<CodexTextClass["cause"], string> = {
  "config-incompatible":
    "This Codex CLI cannot load your Codex configuration. Fix the reported setting or upgrade the Codex CLI (newer versions also support --ignore-user-config, which Groot uses automatically). Groot never edits your Codex config.",
  quota:
    "The Codex account is out of usage; wait for the limit to reset (or add credits), then resume the task.",
  unauthenticated: "Run `codex login` (or set CODEX_API_KEY), then retry.",
};

export function codexNextStep(cause: CodexTextClass["cause"]): string {
  return NEXT_STEP[cause];
}

function blockedError(found: CodexTextClass): ErrorInfo {
  return errorInfo(
    "GROOT_E_BLOCKED",
    `Codex is blocked (${found.cause}): ${redact(found.detail)}`,
    {
      hint: NEXT_STEP[found.cause],
      details: { cause: found.cause },
    },
  );
}

function itemSummary(item: Record<string, unknown>): { kind: RunnerEvent["kind"]; text: string } {
  const type = asString(item.type) ?? "item";
  switch (type) {
    case "agent_message":
      return { kind: "message", text: asString(item.text) ?? "" };
    case "command_execution":
      return {
        kind: "tool",
        text: `$ ${asString(item.command) ?? "?"} (${asString(item.status) ?? "?"}${asNumber(item.exit_code) === null ? "" : `, exit ${asNumber(item.exit_code)}`})`,
      };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      const paths = changes.map((change) => asString(change?.path) ?? "?").join(", ");
      return { kind: "tool", text: `changed ${paths}` };
    }
    case "mcp_tool_call":
      return {
        kind: "tool",
        text: `mcp ${asString(item.server) ?? "?"}.${asString(item.tool) ?? "?"}`,
      };
    case "web_search":
      return { kind: "tool", text: `web search ${asString(item.query) ?? ""}` };
    case "error":
      return { kind: "notice", text: `error (non-fatal): ${asString(item.message) ?? ""}` };
    default:
      return { kind: "notice", text: type };
  }
}

/** Stateful line parser for one Codex run. */
export class CodexStreamParser implements StreamParser {
  threadId: string | null = null;
  simulated = false;
  lastMessage: string | null = null;
  turnsCompleted = 0;
  turnFailed: string | null = null;
  lastError: string | null = null;
  jsonEvents = 0;
  private tokens: { input: number; cached: number; output: number } | null = null;

  constructor(private readonly wallTimeMs: number) {}

  line(raw: string): RunnerEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return event("unknown", "text", raw);
    }
    const doc = asRecord(parsed);
    if (doc === null) return event("unknown", "json", raw);
    this.jsonEvents++;
    if (doc.simulated === true) this.simulated = true;
    const type = asString(doc.type) ?? "unknown";
    switch (type) {
      case "thread.started":
        this.threadId = asString(doc.thread_id) ?? this.threadId;
        return event("session", type, `thread ${this.threadId ?? "?"}`);
      case "turn.completed":
        this.turnsCompleted++;
        this.addUsage(asRecord(doc.usage));
        return event("result", type, "turn completed");
      case "turn.failed":
        this.turnFailed = asString(asRecord(doc.error)?.message) ?? "turn failed";
        return event("result", type, this.turnFailed);
      case "error":
        this.lastError = asString(doc.message) ?? "error";
        return event("notice", type, `error (non-fatal unless the turn fails): ${this.lastError}`);
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.item(type, asRecord(doc.item) ?? {});
      default:
        return event(type === "turn.started" ? "notice" : "unknown", type, type);
    }
  }

  private item(type: string, item: Record<string, unknown>): RunnerEvent {
    const summary = itemSummary(item);
    if (type === "item.completed" && item.type === "agent_message") this.lastMessage = summary.text;
    if (item.type === "error") this.lastError = asString(item.message) ?? this.lastError;
    return event(summary.kind, `${type}/${asString(item.type) ?? "item"}`, summary.text);
  }

  private addUsage(usage: Record<string, unknown> | null): void {
    if (usage === null) return;
    const value = (key: string): number => Math.max(0, Math.round(asNumber(usage[key]) ?? 0));
    const current = this.tokens ?? { input: 0, cached: 0, output: 0 };
    // reasoning_output_tokens (newer builds) is a breakdown of output_tokens, not an addition.
    this.tokens = {
      input: current.input + value("input_tokens"),
      cached: current.cached + value("cached_input_tokens"),
      output: current.output + value("output_tokens"),
    };
  }

  usage(durationMs: number): UsageReport {
    if (this.tokens === null) {
      return unavailableUsage(
        durationMs,
        "codex exec --json: no turn.completed usage was reported",
      );
    }
    return {
      kind: "tokens",
      costUsd: null,
      inputTokens: this.tokens.input,
      outputTokens: this.tokens.output,
      cachedInputTokens: this.tokens.cached,
      turns: this.turnsCompleted,
      durationMs: Math.max(0, Math.round(durationMs)),
      source:
        "codex exec --json turn.completed usage — token counts only (Codex reports no cost); input includes cached input",
    };
  }

  finish(exit: SupervisedExit): RunnerResult {
    const outcome = this.outcome(exit);
    const notes = [
      ...(this.simulated ? ["simulated runner (test double) — not live evidence"] : []),
    ];
    return {
      status: outcome.status,
      error: outcome.error,
      sessionId: this.threadId,
      exitCode: exit.exitCode,
      usage: this.usage(exit.durationMs),
      finalMessage:
        this.lastMessage === null ? null : redact(this.lastMessage).slice(0, FINAL_MESSAGE_CAP),
      simulated: this.simulated,
      notes: [...notes, ...exitNotes(exit)],
    };
  }

  private outcome(exit: SupervisedExit): { status: AttemptStatus; error: ErrorInfo | null } {
    if (exit.spawnError !== null) {
      return {
        status: "failed",
        error: errorInfo("GROOT_E_RUNNER_UNAVAILABLE", `Could not start Codex: ${exit.spawnError}`),
      };
    }
    if (exit.cancelled) {
      return {
        status: "interrupted",
        error: errorInfo(
          "GROOT_E_INTERRUPTED",
          "The run was cancelled; its thread can be resumed.",
        ),
      };
    }
    if (exit.timedOut) {
      return {
        status: "timed-out",
        error: errorInfo(
          "GROOT_E_COMMAND_FAILED",
          `Wall time of ${Math.round(this.wallTimeMs / 1000)} s exceeded; the runner was stopped.`,
          { details: { cause: "wall-time" } },
        ),
      };
    }
    if (this.turnFailed !== null) {
      const found = classifyCodexText(this.turnFailed);
      return {
        status: "failed",
        error:
          found === null
            ? errorInfo("GROOT_E_COMMAND_FAILED", `Codex turn failed: ${redact(this.turnFailed)}`, {
                details: { cause: "turn-failed" },
              })
            : blockedError(found),
      };
    }
    if (this.turnsCompleted > 0 && exit.exitCode === 0) return { status: "succeeded", error: null };
    return { status: "failed", error: this.failureWithoutTerminalEvent(exit) };
  }

  private failureWithoutTerminalEvent(exit: SupervisedExit): ErrorInfo {
    const text = `${exit.stderrTail}\n${this.lastError ?? ""}`;
    const found = classifyCodexText(text);
    if (found !== null) return blockedError(found);
    if (/unexpected argument|unrecognized|invalid value/i.test(exit.stderrTail)) {
      return errorInfo(
        "GROOT_E_RUNNER_UNAVAILABLE",
        `Codex rejected Groot's flags: ${truncate(exit.stderrTail, 300)}`,
        { hint: "Upgrade the Codex CLI, then retry.", details: { cause: "incompatible" } },
      );
    }
    const tail = truncate(redact(exit.stderrTail), 300);
    return errorInfo(
      "GROOT_E_COMMAND_FAILED",
      `Codex exited (${exit.exitCode ?? exit.signal ?? "?"}) without completing its turn${tail === "" ? "." : `: ${tail}`}`,
      { details: { cause: "no-terminal-event" } },
    );
  }
}
