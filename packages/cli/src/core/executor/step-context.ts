/**
 * What a step's effect receives and returns. Effects are pure "do the thing"
 * functions: the step runner (runner.ts) owns checkpoints — expectation
 * checks, intent/backups before, journal + state after — so every effect is
 * journaled the same way.
 */
import type { PathHashes } from "../contracts/operation.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import type { CoreContext } from "../runtime.ts";
import type { ProducedHash } from "./freshness.ts";
import type { OperationPaths } from "./journal.ts";
import type { SecretBook } from "./secrets.ts";

export interface StepContext {
  readonly ctx: CoreContext;
  /** Canonical (realpath) project root. */
  readonly root: string;
  readonly plan: OperationPlan;
  readonly operationId: string;
  readonly paths: OperationPaths;
  readonly secrets: SecretBook;
  /** After-hashes journaled by completed steps (for "produced" expectations). */
  readonly produced: ProducedHash;
}

export interface StepEffect {
  readonly outcome: "applied" | "already-applied" | "reconciled";
  /** Hash of every tracked key after the effect (null = absent). */
  readonly after: PathHashes;
  /** Paths the step created beyond its tracked keys (parent directories). */
  readonly created: readonly string[];
  /** Log file relative to the operation directory, for process steps. */
  readonly logRef: string | null;
}

/** Variable that arms the test-only crash hook (crash.ts); never passed to children. */
export const CRASH_ENV = "GROOT_INTERNAL_CRASH_AT";

/**
 * Environment for a child process: the caller's environment, the step's
 * declared (non-secret) variables, and CI=1 so no tool falls back to an
 * interactive prompt (the v1 engine's generator rule, engine/run.ts).
 */
export function childEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...extra, CI: "1" };
  delete env[CRASH_ENV];
  return env;
}

/** Thrown by a process step when the operation's AbortSignal stopped it mid-effect. */
export function interruptedError(stepId: string, signal: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_INTERRUPTED", `Interrupted (${signal}) during step ${stepId}.`, {
    details: { stepId, signal },
  });
}

/** Name of the signal that aborted the context ("SIGINT" from the CLI runner), or "abort". */
export function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "abort";
}
