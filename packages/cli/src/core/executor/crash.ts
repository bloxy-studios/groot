/**
 * TEST-ONLY crash injection — not a user feature and not part of the CLI
 * contract. When GROOT_INTERNAL_CRASH_AT equals "<stepId>:after-intent" or
 * "<stepId>:after-effect", the process SIGKILLs itself at that checkpoint.
 * Process-level tests use it to prove recovery from a hard crash on either
 * side of a step's effect (journaled intent without completion), which no
 * signal handler or `finally` block can soften. Inert when the variable is
 * unset or names another point; never forwarded to child processes.
 */
import { CRASH_ENV } from "./step-context.ts";

export type CrashPoint = "after-intent" | "after-effect";

/** Upper bound on how long the thread parks while the kernel delivers SIGKILL. */
const PARK_MS = 10_000;

export function crashPoint(
  env: Readonly<Record<string, string | undefined>>,
  stepId: string,
  point: CrashPoint,
): void {
  if (env[CRASH_ENV] !== `${stepId}:${point}`) return;
  process.kill(process.pid, "SIGKILL");
  // Park synchronously so nothing (no journal write) runs after the kill request.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PARK_MS);
}
