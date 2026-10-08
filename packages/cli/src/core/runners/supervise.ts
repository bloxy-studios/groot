/**
 * Supervision of one runner process. The agent runs detached as its own
 * process-group leader (Bun's kill/timeout/AbortSignal reach only the direct
 * child; agents spawn shells, test runners, and dev servers). Cancellation
 * escalates like a careful human would: SIGINT to the group (lets Claude
 * finish the turn and write a result) → SIGTERM after the interrupt grace →
 * SIGKILL after the terminate grace. After exit the group is swept, so
 * nothing the agent started outlives the attempt, and the sweep is reported.
 *
 * stdout is consumed line by line (JSONL); every line is redacted before it
 * reaches the attempt log. stdin carries the prompt and is then closed.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../ids.ts";
import { killTree } from "../process.ts";
import { redact } from "../redact.ts";
import type { CancelGrace } from "./types.ts";

const isPosix = process.platform !== "win32";
/** Wait this long for buffered output after exit before sweeping the group. */
const DRAIN_MS = 1500;
const STDERR_CAP = 64 * 1024;
const LOG_CAP_BYTES = 50 * 1024 * 1024;

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

  /** One provider output line (already a JSON document, or raw text). */
  line(text: string): void {
    this.append(redact(text, this.secrets));
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
  /** Raw stdout line (the parser redacts what it keeps). */
  readonly onLine: (line: string) => void;
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

/**
 * Runner groups alive in this process. Runners are detached, so if Groot
 * itself exits abruptly (a forced second Ctrl-C, an uncaught error) they
 * would outlive it; the exit hook kills every registered group.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const group of liveGroups) killTree(group, "SIGKILL");
  });
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Members of a process group (best effort: pgrep; 1 when only liveness is known). */
export async function groupMembers(pgid: number): Promise<number[]> {
  if (!isPosix || !groupAlive(pgid)) return [];
  try {
    const proc = Bun.spawn(["pgrep", "-g", String(pgid)], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = text
      .split("\n")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    return pids.length > 0 ? pids : groupAlive(pgid) ? [pgid] : [];
  } catch {
    return groupAlive(pgid) ? [pgid] : [];
  }
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await Bun.sleep(50);
  }
  return !groupAlive(pgid);
}

/** Terminate whatever is left in the group; returns [found, leftover]. */
async function sweepGroup(pgid: number): Promise<[number, number]> {
  if (!isPosix || !groupAlive(pgid)) return [0, 0];
  const found = (await groupMembers(pgid)).length;
  killTree(pgid, "SIGTERM");
  if (!(await waitGroupGone(pgid, 2000))) {
    killTree(pgid, "SIGKILL");
    await waitGroupGone(pgid, 2000);
  }
  return [found, (await groupMembers(pgid)).length];
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

/** Spawn and supervise a runner process (see the module comment). */
export function supervise(options: SuperviseOptions): Supervised {
  const { log } = options;
  if (options.signal.aborted) {
    log.record("not-started", { reason: "cancelled before the runner started" });
    return neverRan({ cancelled: true });
  }
  const started = performance.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...options.argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: isPosix,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.record("spawn-failed", { error: message });
    return neverRan({ spawnError: message });
  }
  log.record("spawn", { pid: proc.pid, argv: options.argv, cwd: options.cwd });
  if (isPosix) trackGroup(proc.pid);

  let exited = false;
  let timedOut = false;
  let cancelled = false;
  const exitedPromise = proc.exited.then((code) => {
    exited = true;
    return code;
  });

  let stopping: Promise<void> | null = null;
  const stop = (reason: string): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (exited) return;
      log.record("signal", { signal: "SIGINT", reason });
      killTree(proc.pid, "SIGINT");
      if (await within(exitedPromise, options.grace.interruptMs)) return;
      log.record("signal", { signal: "SIGTERM", reason });
      killTree(proc.pid, "SIGTERM");
      if (await within(exitedPromise, options.grace.terminateMs)) return;
      log.record("signal", { signal: "SIGKILL", reason });
      killTree(proc.pid, "SIGKILL");
      await exitedPromise;
    })();
    return stopping;
  };

  const wallTimer = setTimeout(() => {
    timedOut = true;
    void stop(`wall time of ${options.wallTimeMs} ms exceeded`);
  }, options.wallTimeMs);
  const onAbort = (): void => {
    // An abort that lands after the runner already exited doesn't relabel the run.
    if (!exited) cancelled = true;
    void stop("cancelled");
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  const readers = Promise.all([
    readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      log.line(line);
      options.onLine(line);
    }),
    readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      stderr = `${stderr}${line}\n`.slice(-STDERR_CAP);
      log.record("stderr", { line });
    }),
  ]).catch(() => undefined);

  const done = (async (): Promise<SupervisedExit> => {
    const code = await exitedPromise;
    clearTimeout(wallTimer);
    options.signal.removeEventListener("abort", onAbort);
    await stopping;
    await within(readers, DRAIN_MS);
    const [survivors, leftover] = await sweepGroup(proc.pid);
    if (leftover === 0) liveGroups.delete(proc.pid);
    await within(readers, DRAIN_MS);
    const exit: SupervisedExit = {
      exitCode: proc.signalCode === null ? code : null,
      signal: proc.signalCode ?? null,
      timedOut,
      cancelled,
      spawnError: null,
      stderrTail: log.scrub(stderr),
      durationMs: Math.round(performance.now() - started),
      survivors,
      leftover,
    };
    log.record("exit", {
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut,
      cancelled,
      survivors,
      leftover,
      durationMs: exit.durationMs,
    });
    return exit;
  })();

  return {
    done,
    async cancel(): Promise<void> {
      if (!exited) cancelled = true;
      await stop("cancelled");
      await done;
    },
  };
}
