/**
 * v2 error model: stable `GROOT_E_*` identifiers mapped onto coarse exit
 * codes. The v1 table (engine/errors.ts: 0/1/2/3/4/5/130) is unchanged and
 * reused; v2 surfaces add 6 (conflict), 7 (blocked), 8 (locked).
 * docs/v2-cli-spec.md#errors is the normative list.
 */

import { EXIT, GrootError } from "../engine/errors.ts";
import type { ErrorId, ErrorInfo } from "./contracts/envelope.ts";

export const EXIT_V2 = {
  ...EXIT,
  /** Stale plan, changed precondition, ownership or rollback conflict. */
  CONFLICT: 6,
  /** Missing prerequisite/credential or a decision only a human can make. */
  BLOCKED: 7,
  /** Another Groot writer holds the project lock. */
  LOCKED: 8,
} as const;

export type ExitCodeV2 = (typeof EXIT_V2)[keyof typeof EXIT_V2];

const EXIT_BY_ID: Record<ErrorId, ExitCodeV2> = {
  GROOT_E_INTERNAL: EXIT_V2.INTERNAL,
  GROOT_E_USAGE: EXIT_V2.USAGE,
  GROOT_E_PREFLIGHT: EXIT_V2.PREFLIGHT,
  GROOT_E_GENERATOR: EXIT_V2.GENERATOR,
  GROOT_E_COMMAND_FAILED: EXIT_V2.GENERATOR,
  GROOT_E_VERIFY_FAILED: EXIT_V2.STITCH,
  GROOT_E_NOT_A_PROJECT: EXIT_V2.USAGE,
  GROOT_E_NOT_REGISTERED: EXIT_V2.USAGE,
  GROOT_E_MIGRATION_REQUIRED: EXIT_V2.USAGE,
  GROOT_E_UNSUPPORTED_SCHEMA: EXIT_V2.USAGE,
  GROOT_E_INVALID_DOCUMENT: EXIT_V2.USAGE,
  GROOT_E_UNSUPPORTED_PROJECT: EXIT_V2.USAGE,
  GROOT_E_INCOMPATIBLE: EXIT_V2.USAGE,
  GROOT_E_UNKNOWN_CAPABILITY: EXIT_V2.USAGE,
  GROOT_E_STALE_PLAN: EXIT_V2.CONFLICT,
  GROOT_E_CONFLICT: EXIT_V2.CONFLICT,
  GROOT_E_OWNERSHIP_CONFLICT: EXIT_V2.CONFLICT,
  GROOT_E_ROLLBACK_CONFLICT: EXIT_V2.CONFLICT,
  GROOT_E_PATH_OUTSIDE_PROJECT: EXIT_V2.USAGE,
  GROOT_E_POLICY_DENIED: EXIT_V2.BLOCKED,
  GROOT_E_BLOCKED: EXIT_V2.BLOCKED,
  GROOT_E_LOCKED: EXIT_V2.LOCKED,
  GROOT_E_INTERRUPTED: EXIT_V2.CANCELLED,
  GROOT_E_NOT_FOUND: EXIT_V2.USAGE,
  GROOT_E_NOT_RESUMABLE: EXIT_V2.USAGE,
  GROOT_E_RUNNER_UNAVAILABLE: EXIT_V2.BLOCKED,
  GROOT_E_TASK_STATE: EXIT_V2.USAGE,
};

/** Exit code for a stable error id. */
export function exitCodeFor(id: ErrorId): ExitCodeV2 {
  return EXIT_BY_ID[id];
}

/**
 * A presentable v2 failure. Extends the v1 GrootError so existing catch sites
 * (and the v1 exit-code contract) keep working unchanged.
 */
export class GrootV2Error extends GrootError {
  readonly id: ErrorId;
  readonly details: Record<string, unknown> | null;

  constructor(
    id: ErrorId,
    message: string,
    options: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    // The v1 base types exitCode as the v1 union; v2 codes (6/7/8) are a
    // deliberate superset used only by v2 surfaces.
    super(message, exitCodeFor(id) as never, options.hint);
    this.name = "GrootV2Error";
    this.id = id;
    this.details = options.details ?? null;
  }

  toInfo(): ErrorInfo {
    return {
      id: this.id,
      message: this.message,
      hint: this.hint ?? null,
      exitCode: this.exitCode,
      details: this.details,
    };
  }
}

const V1_EXIT_TO_ID: Record<number, ErrorId> = {
  [EXIT.INTERNAL]: "GROOT_E_INTERNAL",
  [EXIT.USAGE]: "GROOT_E_USAGE",
  [EXIT.PREFLIGHT]: "GROOT_E_PREFLIGHT",
  [EXIT.GENERATOR]: "GROOT_E_GENERATOR",
  [EXIT.STITCH]: "GROOT_E_VERIFY_FAILED",
  [EXIT.CANCELLED]: "GROOT_E_INTERRUPTED",
};

/** Normalize anything thrown into a structured ErrorInfo (never leaks a stack to stdout). */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof GrootV2Error) return error.toInfo();
  if (error instanceof GrootError) {
    const id = V1_EXIT_TO_ID[error.exitCode] ?? "GROOT_E_INTERNAL";
    return {
      id,
      message: error.message,
      hint: error.hint ?? null,
      exitCode: error.exitCode,
      details: null,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: "GROOT_E_INTERNAL",
    message,
    hint: "This is a bug in groot — please report it with the command you ran.",
    exitCode: EXIT_V2.INTERNAL,
    details: null,
  };
}
