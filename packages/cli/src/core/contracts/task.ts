/**
 * Task contract — bounded work delegated to an installed coding agent
 * (Claude Code, Codex) through its documented programmatic interface. A task
 * has an objective, explicit dependencies, file ownership, acceptance
 * criteria, runtime limits, a lifecycle status, attempts with observed usage,
 * evidence, a review, and an integration record. Completion is decided by
 * acceptance checks and review — never by an agent's final message.
 */
import { z } from "zod";
import {
  EvidenceId,
  IsoDate,
  RelPath,
  ReviewId,
  TaskId,
  UnitPath,
  VerificationProfile,
} from "./common.ts";
import { ErrorInfo } from "./envelope.ts";

export const RunnerId = z.enum(["claude-code", "codex"]);
export type RunnerId = z.infer<typeof RunnerId>;

export const TaskStatus = z.enum([
  "pending",
  "running",
  "blocked",
  "interrupted",
  "failed",
  "awaiting-review",
  "completed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AcceptanceCriterion = z
  .object({
    id: z.string(),
    description: z.string(),
    /** command: run argv in the task worktree · verify: run a groot verification profile. */
    kind: z.enum(["command", "verify"]),
    argv: z.array(z.string()).nullable(),
    cwd: UnitPath,
    profile: VerificationProfile.nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

/**
 * Usage as the runner actually reported it. `observed-cost` comes from the
 * runner's own accounting; `tokens` has counts without a price; `unavailable`
 * means the runner exposes nothing (subscription sessions often).
 */
export const UsageReport = z
  .object({
    kind: z.enum(["observed-cost", "tokens", "unavailable"]),
    costUsd: z.number().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    turns: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
    source: z.string(),
  })
  .strict();
export type UsageReport = z.infer<typeof UsageReport>;

export const AttemptStatus = z.enum([
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "timed-out",
  "budget-exceeded",
]);

export const Attempt = z
  .object({
    n: z.number().int().positive(),
    runner: RunnerId,
    /** Runner session/thread id — enables provider-supported continuation. */
    sessionId: z.string().nullable(),
    resumedFrom: z.string().nullable(),
    startedAt: IsoDate,
    finishedAt: IsoDate.nullable(),
    status: AttemptStatus,
    exitCode: z.number().int().nullable(),
    usage: UsageReport,
    /** Redacted runner event stream (.groot/tasks/<id>/attempt-<n>.jsonl). */
    eventsLog: RelPath,
    finalMessage: z.string().nullable(),
    error: ErrorInfo.nullable(),
  })
  .strict();
export type Attempt = z.infer<typeof Attempt>;

export const TaskLimits = z
  .object({
    wallTimeSec: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    /** Enforced only where the runner supports a spend limit; reported otherwise. */
    maxBudgetUsd: z.number().positive().nullable(),
    /** Total attempts including the first (bounded retries). */
    maxAttempts: z.number().int().min(1).max(5),
  })
  .strict();
export type TaskLimits = z.infer<typeof TaskLimits>;

export const ReviewFile = z
  .object({
    path: z.string(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    withinOwnership: z.boolean(),
  })
  .strict();

export const Review = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.review"),
    id: ReviewId,
    taskId: TaskId,
    createdAt: IsoDate,
    base: z.string(),
    head: z.string(),
    files: z.array(ReviewFile),
    acceptance: z.array(
      z
        .object({
          criterion: z.string(),
          status: z.enum(["pass", "fail", "skipped", "blocked"]),
          evidence: EvidenceId.nullable(),
        })
        .strict(),
    ),
    ownershipViolations: z.array(z.string()),
    /** Secret-looking additions found in the diff (names/locations only). */
    secretFindings: z.array(z.string()),
    verdict: z.enum(["pending", "approved", "changes-requested"]),
    reviewer: z.enum(["human", "policy"]).nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type Review = z.infer<typeof Review>;

export const Integration = z
  .object({
    status: z.enum(["integrated", "conflicted", "failed"]),
    /** Commit created on the target branch. */
    commit: z.string().nullable(),
    targetBranch: z.string(),
    /** Fresh verification run against the integrated result. */
    evidence: z.array(EvidenceId),
    at: IsoDate,
    detail: z.string(),
  })
  .strict();

export const Task = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.task"),
    id: TaskId,
    title: z.string(),
    objective: z.string(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
    runner: RunnerId,
    model: z.string().nullable(),
    dependsOn: z.array(TaskId),
    /** Globs (project-relative) the task may change; overlaps are serialized. */
    ownership: z.array(z.string()),
    acceptance: z.array(AcceptanceCriterion),
    limits: TaskLimits,
    status: TaskStatus,
    statusReason: z.string().nullable(),
    base: z.object({ branch: z.string().nullable(), commit: z.string() }).strict(),
    worktree: z.object({ path: z.string(), branch: z.string() }).strict().nullable(),
    attempts: z.array(Attempt),
    evidence: z.array(EvidenceId),
    review: ReviewId.nullable(),
    integration: Integration.nullable(),
  })
  .strict();
export type Task = z.infer<typeof Task>;

export const RunnerCapabilities = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.runner"),
    runner: RunnerId,
    available: z.boolean(),
    executable: z.string().nullable(),
    version: z.string().nullable(),
    /** The documented interface Groot drives. */
    interface: z.string(),
    auth: z
      .object({
        status: z.enum(["authenticated", "unauthenticated", "unknown"]),
        method: z.string().nullable(),
        detail: z.string(),
      })
      .strict(),
    features: z
      .object({
        structuredEvents: z.boolean(),
        cancellation: z.enum(["signal", "none"]),
        resume: z.boolean(),
        permissionModes: z.array(z.string()),
        usage: z.enum(["observed-cost", "tokens", "none"]),
        budgetLimit: z.boolean(),
        turnLimit: z.boolean(),
        sandbox: z.enum(["os", "none"]),
      })
      .strict(),
    checkedAt: IsoDate,
    notes: z.array(z.string()),
  })
  .strict();
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

export { RelPath };
