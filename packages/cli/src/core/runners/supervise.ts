/**
 * Supervision of one runner process. The agent runs detached as its own
 * process-group leader (Bun's kill/timeout/AbortSignal reach only the direct
 * child; agents spawn shells, test runners, and dev servers). Cancellation
 * escalates like a careful human would: SIGINT to the group (lets Claude
 * finish the turn and write a result) → SIGTERM after the interrupt grace →
 * SIGKILL after the terminate grace. After exit the group is swept, so
 * nothing the agent started outlives the attempt, and the sweep is reported.
 * While it runs, the group is tracked (groups.ts) so that Groot exiting —
 * normally, on an uncaught error, SIGHUP, or an unhandled SIGTERM — takes it
 * along.
 *
 * stdout is consumed line by line (JSONL); every line is redacted with the
 * run's known secrets before it reaches the attempt log or the parser.
 * stdin carries the prompt and is then closed.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../ids.ts";
import { killTree } from "../process.ts";
import { redact } from "../redact.ts";
import { sweepGroup, trackGroup, untrackGroup } from "./groups.ts";
import type { CancelGrace } from "./types.ts";

export { groupMembers, inspectRunnerGroup, stopRunnerGroup } from "./groups.ts";

const isPosix = process.platform !== "win32";
/** Wait this long for buffered output after exit before sweeping the group. */
const DRAIN_MS = 1500;
const STDERR_CAP = 64 * 1024;
const LOG_CAP_BYTES = 50 * 1024 * 1024;
/** setTimeout fires at once beyond 2^31-1 ms (~24.8 days): longer wall times are capped there. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Redacted JSONL attempt log: provider lines verbatim, Groot records as `groot.*`. */
export class AttemptLog {
  private bytes = 0;
  private truncated = false;

  constructor(
    readonly path: string,
    private readonly secrets: readonly string[],
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Redact text with the run's known secrets plus credential patterns. */
  scrub(text: string): string {
    return redact(text, this.secrets);
  }

  /** Log one provider output line (a JSON document, or raw text); returns it redacted. */
  line(text: string): string {
    const clean = redact(text, this.secrets);
    this.append(clean);
    return clean;
  }

  /** A Groot-authored record. */
  record(type: string, data: Record<string, unknown>): void {
    this.append(
      redact(JSON.stringify({ type: `groot.${type}`, at: nowIso(), ...data }), this.secrets),
    );
  }

  private append(text: string): void {
    if (this.truncated) return;
    const line = `${text.replace(/\n/g, "\\n")}\n`;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > LOG_CAP_BYTES) {
      this.truncated = true;
      appendFileSync(
        this.path,
        `${JSON.stringify({ type: "groot.log-truncated", at: nowIso() })}\n`,
      );
      return;
    }
    appendFileSync(this.path, line);
  }
}

export interface SuperviseOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly wallTimeMs: number;
  readonly signal: AbortSignal;
  readonly grace: CancelGrace;
  readonly log: AttemptLog;
  /** Each stdout line, already redacted with the run's secrets (exactly as logged). */
  readonly onLine: (line: string) => void;
  /** Called with the runner's pid (= its process-group id) right after it spawned. */
  readonly onSpawn?: (pid: number) => void;
}

export interface SupervisedExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | null;
  readonly stderrTail: string;
  readonly durationMs: number;
  /** Processes still in the group after the runner exited (then terminated). */
  readonly survivors: number;
  /** Processes that could not be removed (expected 0). */
  readonly leftover: number;
}

export interface Supervised {
  readonly done: Promise<SupervisedExit>;
  cancel(): Promise<void>;
}

type RunnerProcess = ReturnType<typeof Bun.spawn>;

interface RunState {
  exited: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

/** Resolve after `ms`, or earlier when `promise` settles; never leaves a timer behind. */
function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const bytes of stream) {
    pending += decoder.decode(bytes, { stream: true });
    let index = pending.indexOf("\n");
    while (index !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (line.trim() !== "") onLine(line);
      index = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.trim() !== "") onLine(pending);
}

/** An exit for a process that never ran. */
function neverRan(overrides: Partial<SupervisedExit>): Supervised {
  const exit: SupervisedExit = {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError: null,
    stderrTail: "",
    durationMs: 0,
    survivors: 0,
    leftover: 0,
    ...overrides,
  };
  return { done: Promise.resolve(exit), cancel: async () => {} };
}

/** The runner process, or the spawn error message. */
function spawnRunner(options: SuperviseOptions): RunnerProcess | string {
  try {
    return Bun.spawn([...options.argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: isPosix,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** SIGINT → SIGTERM → SIGKILL to the group, at most once per run. */
function escalation(
  proc: RunnerProcess,
  exited: Promise<number>,
  state: RunState,
  options: SuperviseOptions,
): { stop(reason: string): Promise<void>; idle(): Promise<void> } {
  let stopping: Promise<void> | null = null;
  const send = (signal: NodeJS.Signals, reason: string): void => {
    options.log.record("signal", { signal, reason });
    killTree(proc.pid, signal);
  };
  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      if (state.exited) return;
      send("SIGINT", reason);
      if (await within(exited, options.grace.interruptMs)) return;
      send("SIGTERM", reason);
      if (await within(exited, options.grace.terminateMs)) return;
      send("SIGKILL", reason);
      await exited;
    })();
    return stopping;
  };
  return { stop, idle: () => stopping ?? Promise.resolve() };
}

/** stdout lines go (redacted) to the log and the parser; stderr is kept as a capped tail. */
function collectOutput(
  proc: RunnerProcess,
  options: SuperviseOptions,
): { readonly readers: Promise<unknown>; stderr(): string } {
  let stderr = "";
  const readers = Promise.all([
    readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      options.onLine(options.log.line(line));
    }),
    readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      stderr = `${stderr}${line}\n`.slice(-STDERR_CAP);
      options.log.record("stderr", { line });
    }),
  ]).catch(() => undefined);
  return { readers, stderr: () => stderr };
}

/** After exit: drain output, sweep the group, and record the exit. */
async function settle(
  proc: RunnerProcess,
  code: number,
  state: RunState,
  output: ReturnType<typeof collectOutput>,
  options: SuperviseOptions,
  durationMs: () => number,
): Promise<SupervisedExit> {
  await within(output.readers, DRAIN_MS);
  const [survivors, leftover] = await sweepGroup(proc.pid);
  if (leftover === 0) untrackGroup(proc.pid);
  await within(output.readers, DRAIN_MS);
  const exit: SupervisedExit = {
    exitCode: proc.signalCode === null ? code : null,
    signal: proc.signalCode ?? null,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    spawnError: null,
    stderrTail: options.log.scrub(output.stderr()),
    durationMs: durationMs(),
    survivors,
    leftover,
  };
  options.log.record("exit", {
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut: exit.timedOut,
    cancelled: exit.cancelled,
    survivors,
    leftover,
    durationMs: exit.durationMs,
  });
  return exit;
}

/** Stop the run when the wall time runs out or the caller aborts; returns the disarm. */
function armStops(
  state: RunState,
  stop: (reason: string) => Promise<void>,
  options: SuperviseOptions,
): () => void {
  const wallTimer = setTimeout(
    () => {
      state.timedOut = true;
      void stop(`wall time of ${options.wallTimeMs} ms exceeded`);
    },
    Math.min(options.wallTimeMs, MAX_TIMER_MS),
  );
  const onAbort = (): void => {
    // An abort that lands after the runner already exited doesn't relabel the run.
    if (!state.exited) state.cancelled = true;
    void stop("cancelled");
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    clearTimeout(wallTimer);
    options.signal.removeEventListener("abort", onAbort);
  };
}

/** Spawn and supervise a runner process (see the module comment). */
export function supervise(options: SuperviseOptions): Supervised {
  const { log } = options;
  if (options.signal.aborted) {
    log.record("not-started", { reason: "cancelled before the runner started" });
    return neverRan({ cancelled: true });
  }
  const started = performance.now();
  const proc = spawnRunner(options);
  if (typeof proc === "string") {
    log.record("spawn-failed", { error: proc });
    return neverRan({ spawnError: proc });
  }
  log.record("spawn", { pid: proc.pid, argv: options.argv, cwd: options.cwd });
  trackGroup(proc.pid);
  options.onSpawn?.(proc.pid);

  const state: RunState = { exited: false, timedOut: false, cancelled: false };
  const exited = proc.exited.then((code) => {
    state.exited = true;
    return code;
  });
  const { stop, idle } = escalation(proc, exited, state, options);
  const disarm = armStops(state, stop, options);
  const output = collectOutput(proc, options);

  const done = (async (): Promise<SupervisedExit> => {
    const code = await exited;
    disarm();
    await idle();
    return settle(proc, code, state, output, options, () =>
      Math.round(performance.now() - started),
    );
  })();

  return {
    done,
    async cancel(): Promise<void> {
      if (!state.exited) state.cancelled = true;
      await stop("cancelled");
      await done;
    },
  };
}
