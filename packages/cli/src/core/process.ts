/**
 * Child-process supervision for commands, generators, verification servers,
 * and agent runners: prompt-free stdin, bounded wall time, cancellation via
 * AbortSignal, and process-tree termination (the child runs in its own process
 * group on POSIX so SIGTERM/SIGKILL reach grandchildren such as a server a
 * script started). Output is captured with a size cap and redacted before it
 * is persisted anywhere — as a whole after exit, never chunk by chunk, so a
 * secret split across pipe reads is still matched.
 *
 * Why the group sweep: Bun's `kill()`, `timeout`, and `AbortSignal` reach only
 * the direct child (docs/v2-research.md#bun). A script that backgrounds work
 * (`sleep 30 & …`) would otherwise leave orphans behind — and keep our output
 * pipes open — after the child itself exits. So once the child exits (or is
 * cancelled) the whole group gets SIGTERM, is polled with `kill(-pgid, 0)`
 * until it is gone (ESRCH), and is SIGKILLed when the grace period runs out.
 */
import { createLineRedactor, redact } from "./redact.ts";

export interface SpawnOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Called with redacted output as it arrives, in complete lines (a partial
   * last line is held back until its newline, or flushed at exit).
   */
  readonly onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Max characters kept per stream; whole lines ("\r" ends one too) are
   * dropped from the head beyond it.
   */
  readonly captureLimit?: number;
  /** Values to redact exactly from captured output. */
  readonly secrets?: readonly string[];
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly pid: number | null;
}

const isPosix = process.platform !== "win32";

/** Polling interval while waiting for a signalled process group to disappear. */
const SWEEP_POLL_MS = 25;

/** Bound on the final flush of a capture whose pipe reads had to be cancelled. */
const CANCEL_FLUSH_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Send a signal to the child's whole process group (POSIX) or the child (Windows). */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (isPosix) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Process groups started by groot and not yet swept. A forced exit — a second
 * Ctrl-C calls process.exit while a child still runs — skips every pending
 * sweep, so the exit hook SIGKILLs these groups synchronously and nothing
 * outlives groot as an orphan (SIGTERM-ignoring members included).
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** Track a detached child's process group until it is swept; returns the untrack function. */
export function trackProcessGroup(pgid: number): () => void {
  if (!isPosix) return () => {};
  liveGroups.add(pgid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const group of liveGroups) killTree(group, "SIGKILL");
    });
  }
  return () => {
    liveGroups.delete(pgid);
  };
}

/**
 * True while any process in group `pgid` still exists. EPERM means a member
 * belongs to another user — we could not signal it anyway, so it does not
 * count as ours to wait for.
 */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!isPosix) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate everything left in process group `pgid`: SIGTERM, poll until the
 * group is gone (ESRCH) within `graceMs`, then SIGKILL. Resolves once the
 * group is empty or SIGKILL was sent. No-op on Windows (no process groups).
 */
export async function sweepProcessGroup(pgid: number, graceMs = 3000): Promise<void> {
  if (!isPosix || !isProcessGroupAlive(pgid)) return;
  killTree(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(SWEEP_POLL_MS);
    if (!isProcessGroupAlive(pgid)) return;
  }
  killTree(pgid, "SIGKILL");
  // SIGKILL cannot be ignored; give the kernel a moment to reap the members.
  const reapDeadline = Date.now() + 1000;
  while (Date.now() < reapDeadline && isProcessGroupAlive(pgid)) await sleep(SWEEP_POLL_MS);
}

/**
 * End of the first line boundary at or after `from` — "\n", "\r\n", or a lone
 * "\r" (progress output redraws one line with it) — or -1. Secrets and
 * assignments never span one, so a cut there keeps none of them in part.
 */
function lineBoundaryEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const carriageReturn = text.indexOf("\r", from);
  if (carriageReturn === -1 || (newline !== -1 && newline < carriageReturn)) {
    return newline === -1 ? -1 : newline + 1;
  }
  return text[carriageReturn + 1] === "\n" ? carriageReturn + 2 : carriageReturn + 1;
}

/**
 * Raw output with its head dropped beyond `limit` characters. Cuts fall on
 * line boundaries ("\r" counts), so the capture — redacted once, as a whole —
 * never holds a line (or a secret) whose start was cut off. A single line
 * longer than `limit` is dropped until its boundary arrives.
 */
function cappedText(limit: number): { append: (chunk: string) => void; value: () => string } {
  let text = "";
  let inDroppedLine = false; // the last cut fell inside the line still being written
  return {
    append(chunk: string): void {
      let next = chunk;
      if (inDroppedLine) {
        const boundary = lineBoundaryEnd(next, 0);
        if (boundary === -1) return;
        next = next.slice(boundary);
        inDroppedLine = false;
      }
      text += next;
      if (text.length <= limit) return;
      const boundary = lineBoundaryEnd(text, text.length - limit - 1);
      inDroppedLine = boundary === -1;
      text = inDroppedLine ? "" : text.slice(boundary);
    },
    value: () => text,
  };
}

interface OutputCapture {
  readonly done: Promise<void>;
  /** The whole capture, redacted. */
  readonly text: () => string;
  /** Stop reading (a process outside the group may still hold the pipe open). */
  readonly cancel: () => void;
}

function captureStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  name: "stdout" | "stderr",
  options: Pick<SpawnOptions, "onOutput">,
  limit: number,
  secrets: readonly string[],
): OutputCapture {
  const raw = cappedText(limit);
  const text = (): string => redact(raw.value(), secrets);
  if (stream === null || stream === undefined) {
    return { done: Promise.resolve(), text, cancel: () => {} };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines = options.onOutput === undefined ? null : createLineRedactor(secrets);
  const emit = (redacted: string | undefined): void => {
    if (redacted !== undefined && redacted !== "") options.onOutput?.(redacted, name);
  };
  const push = (chunk: string): void => {
    if (chunk.length === 0) return;
    raw.append(chunk);
    emit(lines?.push(chunk));
  };
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // cancelled or the pipe broke — keep what was captured
    }
    push(decoder.decode());
    emit(lines?.flush());
  })();
  return {
    done,
    text,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

/** Resolve when `promise` settles or `ms` elapses; true when it settled in time. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}

function abortedBeforeStart(): SpawnResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: true,
    durationMs: 0,
    pid: null,
  };
}

export async function runProcess(options: SpawnOptions): Promise<SpawnResult> {
  const started = performance.now();
  const limit = options.captureLimit ?? 2_000_000;
  const secrets = options.secrets ?? [];
  const grace = options.killGraceMs ?? 3000;
  if (options.signal?.aborted) return abortedBeforeStart();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...options.argv], {
      cwd: options.cwd,
      env: (options.env ?? process.env) as Record<string, string | undefined>,
      stdin: new TextEncoder().encode(options.stdin ?? ""),
      stdout: "pipe",
      stderr: "pipe",
      detached: isPosix,
    });
  } catch (error) {
    return {
      exitCode: 127,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      aborted: false,
      durationMs: Math.round(performance.now() - started),
      pid: null,
    };
  }

  const untrack = trackProcessGroup(proc.pid);
  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    killTree(proc.pid, "SIGTERM");
    killTimer = setTimeout(() => killTree(proc.pid, "SIGKILL"), grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const stdout = captureStream(
    proc.stdout as ReadableStream<Uint8Array>,
    "stdout",
    options,
    limit,
    secrets,
  );
  const stderr = captureStream(
    proc.stderr as ReadableStream<Uint8Array>,
    "stderr",
    options,
    limit,
    secrets,
  );

  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);
  options.signal?.removeEventListener("abort", onAbort);
  // Reap anything the child left running in its group (servers, `cmd &` jobs).
  await sweepProcessGroup(proc.pid, grace);
  untrack();
  // The pipes close once the last writer is gone; bound the wait in case a
  // process that escaped the group (its own setsid) still holds them.
  const drained = await settledWithin(Promise.all([stdout.done, stderr.done]), grace);
  if (!drained) {
    stdout.cancel();
    stderr.cancel();
    // Cancelling settles the pending reads; let each capture flush its held-back line.
    await settledWithin(Promise.all([stdout.done, stderr.done]), CANCEL_FLUSH_MS);
  }

  return {
    exitCode: proc.signalCode === null ? exitCode : null,
    signal: proc.signalCode ?? null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut,
    aborted,
    durationMs: Math.round(performance.now() - started),
    pid: proc.pid,
  };
}

/** Last `count` non-empty lines of process output (for error messages). */
export function tail(output: string, count = 15): string {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join("\n");
}
