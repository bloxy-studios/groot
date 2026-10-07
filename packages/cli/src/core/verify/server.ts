/**
 * Server harness for runtime and product-flow checks: start an app's server
 * on an ephemeral loopback port in its own process group, wait until it
 * answers HTTP, and always tear the whole group down — including anything
 * the dev script spawned — when the check ends.
 */

import { killTree } from "../process.ts";
import { redact } from "../redact.ts";

export interface ServerOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port: number;
  /** Path probed for readiness (any HTTP response counts as up). */
  readonly readyPath: string;
  readonly readyTimeoutMs: number;
  readonly secrets: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RunningServer {
  readonly baseUrl: string;
  readonly pid: number;
  /** Stop the process group; resolves with the redacted combined log. */
  stop(): Promise<string>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const proc = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    env: options.env as Record<string, string | undefined>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let log = "";
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
  };
  const pumps = Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>),
    pump(proc.stderr as ReadableStream<Uint8Array>),
  ]).catch(() => {});

  let stopped = false;
  const stop = async (): Promise<string> => {
    if (!stopped) {
      stopped = true;
      killTree(proc.pid, "SIGTERM");
      const exited = await Promise.race([
        proc.exited.then(() => true),
        sleep(3000).then(() => false),
      ]);
      if (!exited) killTree(proc.pid, "SIGKILL");
      // Sweep the group even after the leader exits (scripts may leave children).
      killTree(proc.pid, "SIGKILL");
      await Promise.race([pumps, sleep(1000)]);
    }
    return redact(log, options.secrets);
  };

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + options.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      const output = await stop();
      throw new Error(`cancelled while waiting for the server\n${output}`);
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const output = await stop();
      throw new Error(
        `the server exited (code ${proc.exitCode ?? proc.signalCode}) before it was ready\n${output}`,
      );
    }
    try {
      await fetch(`${baseUrl}${options.readyPath}`, { signal: AbortSignal.timeout(1500) });
      return { baseUrl, pid: proc.pid, stop };
    } catch {
      await sleep(250);
    }
  }
  const output = await stop();
  throw new Error(
    `the server did not answer on ${baseUrl}${options.readyPath} within ${options.readyTimeoutMs} ms\n${output}`,
  );
}
