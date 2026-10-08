/**
 * The shared v2 command runner — every v2 command goes through it, so all of
 * them share one machine contract (docs/v2-cli-spec.md#machine-contract):
 *
 * - stdout carries exactly one document with --json (the result envelope), or
 *   the human rendering otherwise;
 * - progress goes to stderr (human lines, or JSONL events with --events);
 * - errors become structured envelopes with stable GROOT_E_* ids and the
 *   mapped exit code; no stack traces on stdout;
 * - SIGINT/SIGTERM abort the core operation through its AbortSignal (the
 *   executor checkpoints and exits 130); a second SIGINT forces exit 130.
 */
import { format } from "node:util";
import pc from "picocolors";
import { schemaUrl } from "../core/contracts/common.ts";
import type {
  BlockedDecision,
  ErrorInfo,
  GrootEvent,
  ResultEnvelope,
} from "../core/contracts/envelope.ts";
import { blockedDecisions, EXIT_V2, GrootV2Error, toErrorInfo } from "../core/errors.ts";
import { redactValue } from "../core/redact.ts";
import {
  type CoreContext,
  createContext,
  type EventInput,
  type EventSink,
  GROOT_VERSION,
  toEvent,
} from "../core/runtime.ts";

export interface GlobalFlags {
  /** Emit the result envelope on stdout. */
  readonly json: boolean;
  /** Emit progress as JSONL events on stderr. */
  readonly events: boolean;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly data: unknown;
  readonly warnings?: readonly string[];
  readonly blocked?: readonly BlockedDecision[];
  readonly refs?: {
    readonly planId?: string | null;
    readonly operationId?: string | null;
    readonly taskId?: string | null;
    readonly evidence?: readonly string[];
  };
  /** Defaults: 0 when ok; 7 when blocked; 1 otherwise. */
  readonly exitCode?: number;
  /** The structured error of a failed result that still carries data (envelope `error`). */
  readonly error?: ErrorInfo | null;
  /**
   * Human rendering (stdout) when --json is off: print with console.log, or
   * return the text (any other return value is ignored). The runner collects
   * both and writes them with an awaited flush — a large console.log straight
   * to a pipe can be cut at 64 KiB.
   */
  readonly human?: () => unknown;
}

/** Shared citty arg definitions for the v2 machine contract. */
export const GLOBAL_ARGS = {
  json: {
    type: "boolean",
    default: false,
    description: "Print the result envelope (schemas/v2/result.schema.json) on stdout",
  },
  events: {
    type: "boolean",
    default: false,
    description: "Stream progress as JSONL events (schemas/v2/event.schema.json) on stderr",
  },
} as const;

const LEVEL_ICON: Record<GrootEvent["level"], string> = {
  debug: pc.dim("·"),
  info: pc.green("◇"),
  warn: pc.yellow("●"),
  error: pc.red("✗"),
};

export function stderrSink(flags: GlobalFlags): EventSink {
  return {
    emit(input: EventInput): void {
      const event = toEvent(input);
      if (flags.events) {
        process.stderr.write(`${JSON.stringify(redactValue(event))}\n`);
        return;
      }
      if (event.level === "debug") return;
      process.stderr.write(`${LEVEL_ICON[event.level]} ${event.message}\n`);
    },
  };
}

export function envelope(
  command: string,
  result: Partial<CommandResult> & { error?: ErrorInfo | null },
): ResultEnvelope {
  return {
    $schema: schemaUrl("result"),
    schemaVersion: 1,
    kind: "groot.result",
    command,
    ok: result.ok ?? false,
    data: result.data ?? null,
    error: result.error ?? null,
    blocked: [...(result.blocked ?? [])],
    warnings: [...(result.warnings ?? [])],
    refs: {
      planId: result.refs?.planId ?? null,
      operationId: result.refs?.operationId ?? null,
      taskId: result.refs?.taskId ?? null,
      evidence: [...(result.refs?.evidence ?? [])],
    },
    grootVersion: GROOT_VERSION,
  };
}

/**
 * Write to stdout and resolve once the chunk is flushed. Bun can drop piped
 * stdout written immediately before process.exit() (oven-sh/bun#41782 —
 * reproduced 20–50% of runs at 2 MB on Bun 1.4.0), so the runner always
 * awaits the flush before exiting.
 */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

async function printJson(value: unknown): Promise<void> {
  await writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run a human renderer and return what it printed with console.log, plus any
 * text it returned. In Bun, a console.log larger than the pipe buffer loses
 * everything past 64 KiB once process.stdout has been touched (picocolors
 * does at import), so the runner writes the collected text itself.
 */
export function renderHuman(human: CommandResult["human"]): string {
  if (human === undefined) return "";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(`${format(...args)}\n`);
  };
  let returned: unknown;
  try {
    returned = human();
  } finally {
    console.log = log;
  }
  if (typeof returned === "string" && returned !== "") {
    lines.push(returned.endsWith("\n") ? returned : `${returned}\n`);
  }
  return lines.join("");
}

/**
 * A result's blocked[]: never empty when it exits 7 — a result without its
 * own decisions gets one derived from its error (docs/v2-cli-spec.md#machine-contract).
 */
function resultBlocked(
  command: string,
  result: CommandResult,
  exitCode: number,
): BlockedDecision[] {
  const blocked = [...(result.blocked ?? [])];
  if (blocked.length > 0 || exitCode !== EXIT_V2.BLOCKED) return blocked;
  const info: ErrorInfo = result.error ?? {
    id: "GROOT_E_BLOCKED",
    message: `groot ${command} needs a decision or prerequisite before it can continue.`,
    hint: null,
    exitCode: EXIT_V2.BLOCKED,
    details: null,
  };
  return blockedDecisions(null, { ...info, exitCode: EXIT_V2.BLOCKED });
}

function printHumanError(error: ErrorInfo): void {
  process.stderr.write(`${pc.red("groot error:")} ${error.message}\n`);
  if (error.hint !== null) process.stderr.write(`  ${pc.dim(error.hint)}\n`);
}

function printBlocked(blocked: readonly BlockedDecision[]): void {
  for (const decision of blocked) {
    process.stderr.write(`${pc.yellow("●")} ${pc.bold(decision.question)}\n`);
    for (const option of decision.options) {
      const mark = option.recommended ? pc.green(" (recommended)") : "";
      process.stderr.write(`    ${option.id}: ${option.label}${mark} — ${pc.dim(option.effect)}\n`);
    }
    process.stderr.write(`    ${pc.cyan("resolve with:")} ${decision.resolveWith}\n`);
  }
}

/**
 * Run a v2 command body and exit with the contract's code. Never returns.
 */
export async function runV2Command(
  command: string,
  flags: GlobalFlags,
  body: (ctx: CoreContext) => Promise<CommandResult>,
): Promise<never> {
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupts++;
    if (interrupts > 1) process.exit(EXIT_V2.CANCELLED);
    process.stderr.write(
      `${pc.yellow("●")} ${signal} received — stopping at the next safe checkpoint (press Ctrl-C again to force).\n`,
    );
    controller.abort(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const ctx = createContext({
    cwd: process.cwd(),
    signal: controller.signal,
    events: stderrSink(flags),
  });

  let exitCode: number;
  try {
    const result = await body(ctx);
    exitCode =
      result.exitCode ??
      (result.ok
        ? EXIT_V2.OK
        : (result.blocked ?? []).length > 0
          ? EXIT_V2.BLOCKED
          : EXIT_V2.INTERNAL);
    const blocked = resultBlocked(command, result, exitCode);
    if (flags.json) {
      await printJson(envelope(command, { ...result, blocked }));
    } else {
      await writeStdout(renderHuman(result.human));
      for (const warning of result.warnings ?? []) {
        process.stderr.write(`${pc.yellow("●")} ${warning}\n`);
      }
      if (blocked.length > 0) printBlocked(blocked);
    }
  } catch (error) {
    const info = toErrorInfo(error);
    exitCode = info.exitCode;
    if (flags.json) {
      await printJson(
        envelope(command, { ok: false, error: info, blocked: blockedDecisions(error, info) }),
      );
    } else {
      printHumanError(info);
      // A derived decision would only repeat the error and its hint.
      if (error instanceof GrootV2Error && error.blocked.length > 0) printBlocked(error.blocked);
    }
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.exit(exitCode);
}
