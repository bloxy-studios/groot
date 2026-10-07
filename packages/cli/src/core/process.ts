/**
 * Child-process supervision for commands, generators, verification servers,
 * and agent runners: prompt-free stdin, bounded wall time, cancellation via
 * AbortSignal, and process-tree termination (the child runs in its own process
 * group on POSIX so SIGTERM/SIGKILL reach grandchildren such as a server a
 * script started). Output is captured with a size cap and redacted before it
 * is persisted anywhere.
 */
import { redact } from "./redact.ts";

export interface SpawnOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Called with each chunk of combined output (already redacted). */
  readonly onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Max bytes kept per stream (head is dropped beyond it). */
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

function appendCapped(buffer: string, chunk: string, limit: number): string {
  const next = buffer + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export async function runProcess(options: SpawnOptions): Promise<SpawnResult> {
  const started = performance.now();
  const limit = options.captureLimit ?? 2_000_000;
  const secrets = options.secrets ?? [];
  const grace = options.killGraceMs ?? 3000;
  if (options.signal?.aborted) {
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

  let stdout = "";
  let stderr = "";
  const pump = async (
    stream: ReadableStream<Uint8Array> | null | undefined,
    name: "stdout" | "stderr",
  ): Promise<void> => {
    if (stream === null || stream === undefined) return;
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      const chunk = redact(decoder.decode(bytes, { stream: true }), secrets);
      if (name === "stdout") stdout = appendCapped(stdout, chunk, limit);
      else stderr = appendCapped(stderr, chunk, limit);
      options.onOutput?.(chunk, name);
    }
  };

  const [exitCode] = await Promise.all([
    proc.exited,
    pump(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
    pump(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
  ]);
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);
  options.signal?.removeEventListener("abort", onAbort);
  // Reap anything the child left running in its group (servers started by scripts).
  if (isPosix) killTree(proc.pid, "SIGTERM");

  return {
    exitCode: proc.signalCode === null ? exitCode : null,
    signal: proc.signalCode ?? null,
    stdout,
    stderr,
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
