/**
 * Plumbing shared by the runner adapters: the event queue behind
 * RunnerHandle.events, the launch lifecycle (prepare → spawn → parse →
 * classify, with cancellation honored before and after spawn), short probes
 * for discovery, and strict validation of values that reach agent argv.
 */
import { schemaUrl } from "../contracts/common.ts";
import type { ErrorId, ErrorInfo } from "../contracts/envelope.ts";
import { RunnerCapabilities, type RunnerId, type UsageReport } from "../contracts/task.ts";
import { GrootV2Error, toErrorInfo } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { runProcess } from "../process.ts";
import { redact } from "../redact.ts";
import { knownSecretsFromEnv } from "./env.ts";
import { AttemptLog, type SupervisedExit, supervise } from "./supervise.ts";
import {
  DEFAULT_CANCEL_GRACE,
  type RunnerEvent,
  type RunnerHandle,
  type RunnerInvocation,
  type RunnerResult,
} from "./types.ts";

const QUEUE_CAP = 10_000;

/** Single-consumer async queue; the oldest events drop beyond the cap. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
    if (this.items.length > QUEUE_CAP) this.items.shift();
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** What an adapter's prepare step produces: a concrete launch, or an early result. */
export interface LaunchSpec {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly notes: readonly string[];
}

export interface StreamParser {
  /** One raw stdout line → a normalized event (null to skip). */
  line(raw: string): RunnerEvent | null;
  finish(exit: SupervisedExit): RunnerResult;
}

export function errorInfo(
  id: ErrorId,
  message: string,
  options: { hint?: string; details?: Record<string, unknown> } = {},
): ErrorInfo {
  return new GrootV2Error(id, message, options).toInfo();
}

export function unavailableUsage(durationMs: number, source: string): UsageReport {
  return {
    kind: "unavailable",
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    turns: null,
    durationMs: Math.max(0, Math.round(durationMs)),
    source,
  };
}

/** A result for a run that never started (cancelled first, or no executable). */
export function notStartedResult(
  status: "interrupted" | "failed",
  error: ErrorInfo,
  notes: readonly string[],
): RunnerResult {
  return {
    status,
    sessionId: null,
    exitCode: null,
    usage: unavailableUsage(0, "the runner did not start"),
    finalMessage: null,
    error,
    simulated: false,
    notes,
  };
}

async function prepared(
  prepare: () => Promise<LaunchSpec | RunnerResult>,
): Promise<LaunchSpec | RunnerResult> {
  try {
    return await prepare();
  } catch (error) {
    return notStartedResult("failed", toErrorInfo(error), []);
  }
}

/**
 * Final message and error text are persisted in task.json — redact
 * env-derived secrets too, not just credential-shaped patterns.
 */
function scrubbed(
  outcome: RunnerResult,
  notes: readonly string[],
  secrets: readonly string[],
): RunnerResult {
  return {
    ...outcome,
    finalMessage: outcome.finalMessage === null ? null : redact(outcome.finalMessage, secrets),
    error:
      outcome.error === null
        ? null
        : { ...outcome.error, message: redact(outcome.error.message, secrets) },
    notes: [...notes, ...outcome.notes],
  };
}

/** Supervise the prepared launch; parsed events go to `events`. */
function launch(
  invocation: RunnerInvocation,
  spec: LaunchSpec,
  log: AttemptLog,
  parser: StreamParser,
  events: EventQueue<RunnerEvent>,
): ReturnType<typeof supervise> {
  return supervise({
    argv: spec.argv,
    cwd: invocation.cwd,
    env: spec.env,
    stdin: invocation.prompt,
    wallTimeMs: invocation.limits.wallTimeMs,
    signal: invocation.signal,
    grace: invocation.grace ?? DEFAULT_CANCEL_GRACE,
    log,
    onLine: (line) => {
      const event = parser.line(line);
      if (event !== null) events.push(event);
    },
    onSpawn: invocation.onSpawn,
  });
}

/**
 * Start a run: `prepare` resolves the executable and argv (or returns an
 * early result), then the process is supervised and its lines — redacted
 * with the env-derived secrets before anything sees them — are parsed.
 * cancel() works at any point — before spawn it prevents the spawn.
 */
export function startRun(
  invocation: RunnerInvocation,
  prepare: () => Promise<LaunchSpec | RunnerResult>,
  parser: StreamParser,
): RunnerHandle {
  const events = new EventQueue<RunnerEvent>();
  const secrets = knownSecretsFromEnv(invocation.env ?? process.env);
  const log = new AttemptLog(invocation.eventsLogPath, secrets);
  let cancelRequested = false;
  let supervised: ReturnType<typeof supervise> | null = null;

  const run = async (): Promise<RunnerResult> => {
    const spec = await prepared(prepare);
    if ("status" in spec) {
      log.record("not-started", { error: spec.error });
      return spec;
    }
    if (cancelRequested || invocation.signal.aborted) {
      log.record("not-started", { reason: "cancelled before the runner started" });
      const cancelled = errorInfo("GROOT_E_INTERRUPTED", "The run was cancelled.");
      return notStartedResult("interrupted", cancelled, []);
    }
    supervised = launch(invocation, spec, log, parser, events);
    return scrubbed(parser.finish(await supervised.done), spec.notes, secrets);
  };
  const result = run().finally(() => events.close());

  return {
    events,
    result,
    async cancel(): Promise<void> {
      cancelRequested = true;
      if (supervised !== null) await supervised.cancel();
      await result.catch(() => undefined);
    },
  };
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** A short, prompt-free probe (`--version`, `--help`, `auth status`) with a hard timeout. */
export async function probe(
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const result = await runProcess({ argv, cwd: process.cwd(), env, timeoutMs, killGraceMs: 1000 });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

/** Values that become agent argv must never look like flags or carry control characters. */
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export function assertSafeArg(name: string, value: string): string {
  if (!SAFE_ARG.test(value)) {
    throw new GrootV2Error("GROOT_E_USAGE", `Invalid ${name} "${value}".`, {
      hint: `${name} must start with a letter or digit and use only letters, digits, and . _ : / @ [ ] -`,
    });
  }
  return value;
}

/** Characters allowed inside a Claude `Bash(<command> *)` permission rule. */
const SAFE_RULE_COMMAND = /^[A-Za-z0-9._/:=@+-]+(?: [A-Za-z0-9._/:=@+-]+)*$/;

export function isRuleSafeCommand(command: string): boolean {
  return SAFE_RULE_COMMAND.test(command) && command.length <= 200;
}

export function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function event(kind: RunnerEvent["kind"], type: string, summary: string): RunnerEvent {
  return { kind, type, at: nowIso(), summary: truncate(redact(summary)) };
}

/** Notes every adapter adds about process-group hygiene after exit. */
export function exitNotes(exit: SupervisedExit): string[] {
  const notes: string[] = [];
  if (exit.signal !== null) notes.push(`runner ended by ${exit.signal}`);
  if (exit.survivors > 0) {
    notes.push(`terminated ${exit.survivors} leftover process(es) in the runner's process group`);
  }
  if (exit.leftover > 0) {
    notes.push(`WARNING: ${exit.leftover} process(es) survived the process-group sweep`);
  }
  return notes;
}

/**
 * Does an attempt log show the provider establishing its session (Claude
 * `system/init`, Codex `thread.started`)? A pre-assigned session id whose
 * run never got that far does not exist and cannot be resumed.
 */
export function logShowsSession(log: string): boolean {
  return log.split("\n").some((line) => {
    if (!line.includes("init") && !line.includes("thread.started")) return false;
    try {
      const doc = asRecord(JSON.parse(line));
      return (doc?.type === "system" && doc.subtype === "init") || doc?.type === "thread.started";
    } catch {
      return false;
    }
  });
}

export const RUNNER_LABEL: Record<RunnerId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export type CapabilityFields = Omit<
  RunnerCapabilities,
  "$schema" | "schemaVersion" | "kind" | "checkedAt"
>;

/** A validated RunnerCapabilities document. */
export function buildCapabilities(fields: CapabilityFields): RunnerCapabilities {
  return RunnerCapabilities.parse({
    $schema: schemaUrl("runner"),
    schemaVersion: 1,
    kind: "groot.runner",
    ...fields,
    checkedAt: nowIso(),
  });
}

/**
 * The help text of one flag: its own line plus indented continuation lines,
 * up to the next flag or section. (A single regex over the whole help text
 * would happily run on into later flags' descriptions.)
 */
export function flagBlock(help: string, flag: string): string {
  const lines = help.split("\n");
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^\\s*(?:-\\w, )?${escaped}\\b`);
  const start = lines.findIndex((line) => head.test(line));
  if (start === -1) return "";
  const block = [(lines[start] as string).trim()];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,4}-/.test(line)) break; // the next flag
    if (line.trim() !== "" && !/^\s{6,}/.test(line)) break; // a section header
    block.push(line.trim());
  }
  return block.join(" ");
}

/** First semver-looking token in a `--version` output. */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text)?.[1] ?? null;
}

/** OS-level sandboxing exists for both agents on macOS and Linux only. */
export function osSandbox(): "os" | "none" {
  return process.platform === "darwin" || process.platform === "linux" ? "os" : "none";
}
