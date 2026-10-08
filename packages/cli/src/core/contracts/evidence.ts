/**
 * Evidence contract — the outcome of one check, tied to the exact revision and
 * environment it ran against. Structural, build, runtime, and product-flow
 * evidence are reported separately; `skipped` and `blocked` are first-class
 * outcomes with a reason, never silently folded into `pass`. Evidence from a
 * simulated runner or mock is flagged `simulated` and never counts as live
 * end-to-end proof.
 */
import { z } from "zod";
import {
  EnvironmentInfo,
  EvidenceId,
  IsoDate,
  RelPath,
  RevisionInfo,
  Sha256,
  UnitPath,
  VerificationProfile,
} from "./common.ts";

export const EvidenceStatus = z.enum(["pass", "fail", "skipped", "blocked"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

/**
 * `reason` of a check that verification was cancelled before or while it ran
 * (status `skipped`). Such a record says nothing about the check itself, so it
 * never replaces the check's last real result.
 */
export const CANCELLED_REASON = "cancelled";

export const EvidenceArtifact = z
  .object({
    /** Project-relative, under .groot/evidence/<id>/ (secret-redacted). */
    path: RelPath,
    kind: z.enum(["log", "json", "text"]),
    sha256: Sha256,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

export const EvidenceMethod = z
  .object({
    kind: z.enum(["static", "command", "process", "http", "runner"]),
    /** The checker implementation (core/verify registry id). */
    tool: z.string(),
    command: z
      .object({
        argv: z.array(z.string()),
        cwd: UnitPath,
        exitCode: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const Evidence = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.evidence"),
    id: EvidenceId,
    check: z.string(),
    title: z.string(),
    profile: VerificationProfile,
    status: EvidenceStatus,
    scope: z
      .object({
        capability: z.string().nullable(),
        unit: UnitPath.nullable(),
        operationId: z.string().nullable(),
        taskId: z.string().nullable(),
      })
      .strict(),
    method: EvidenceMethod,
    revision: RevisionInfo,
    environment: EnvironmentInfo,
    startedAt: IsoDate,
    finishedAt: IsoDate,
    durationMs: z.number().int().nonnegative(),
    summary: z.string(),
    details: z.record(z.string(), z.unknown()),
    artifacts: z.array(EvidenceArtifact),
    limitations: z.array(z.string()),
    /** Why a check was skipped or blocked. */
    reason: z.string().nullable(),
    /** Actionable next step for blocked checks. */
    nextStep: z.string().nullable(),
    simulated: z.boolean(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

export const ProfileSummary = z
  .object({
    status: z.enum(["pass", "fail", "skipped", "blocked", "not-run"]),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  })
  .strict();
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const VerificationReport = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.verification"),
    root: z.string(),
    revision: RevisionInfo,
    environment: EnvironmentInfo,
    startedAt: IsoDate,
    finishedAt: IsoDate,
    scope: z
      .object({
        capability: z.string().nullable(),
        profiles: z.array(VerificationProfile),
      })
      .strict(),
    profiles: z
      .object({
        structural: ProfileSummary,
        build: ProfileSummary,
        runtime: ProfileSummary,
        "product-flow": ProfileSummary,
      })
      .strict(),
    evidence: z.array(Evidence),
    /** No check failed and the run finished. Blocked/skipped checks are reported, not hidden. */
    ok: z.boolean(),
    /**
     * Verification was cancelled (SIGINT/SIGTERM, MCP cancellation) before
     * every selected check finished: the report is partial, `ok` is false,
     * and each check it never ran — or that failed while it was being
     * cancelled — is `skipped` with reason "cancelled". A signal that arrives
     * as the last check finishes leaves the report complete.
     */
    interrupted: z.boolean().optional(),
  })
  .strict();
export type VerificationReport = z.infer<typeof VerificationReport>;
