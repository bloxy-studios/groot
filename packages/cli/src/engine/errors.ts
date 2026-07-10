/**
 * Error model. Exit codes are part of the public CLI contract — see
 * docs/cli-spec.md#exit-codes. Changing a value is a breaking change.
 */

export const EXIT = {
  /** Success. */
  OK: 0,
  /** Unexpected internal error. */
  INTERNAL: 1,
  /** Invalid flags/arguments. */
  USAGE: 2,
  /** Preflight failure (bun missing, dir conflict under `error` policy, offline). */
  PREFLIGHT: 3,
  /** An upstream generator failed. */
  GENERATOR: 4,
  /** Stitch/verify failure. */
  STITCH: 5,
  /** Cancelled at a prompt. */
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A user-presentable failure carrying its CLI exit code and an optional fix hint. */
export class GrootError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCode, hint?: string) {
    super(message);
    this.name = "GrootError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}
