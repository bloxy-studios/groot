/**
 * Operation contract — execution of a plan, persisted as an append-only
 * journal (.groot/operations/<id>/journal.jsonl) plus a derived state
 * snapshot. Intent is recorded BEFORE each step's effect and completion
 * after it, so an interrupted run can be reconciled step by step: completed
 * steps are never repeated, an in-flight step is checked against its
 * postcondition before anything is re-run.
 */
import { z } from "zod";
import { IsoDate, OperationId, PlanId, RelPath, Sha256 } from "./common.ts";
import { ErrorInfo } from "./envelope.ts";
import { PlanIntent } from "./plan.ts";

/** Path → content hash (null = absent). */
export const PathHashes = z.record(z.string(), Sha256.nullable());
export type PathHashes = z.infer<typeof PathHashes>;

const RecordBase = {
  seq: z.number().int().nonnegative(),
  at: IsoDate,
};

export const JournalRecord = z.discriminatedUnion("type", [
  z
    .object({
      ...RecordBase,
      type: z.literal("operation.started"),
      operationId: OperationId,
      planId: PlanId,
      planFingerprint: Sha256,
      pid: z.number().int(),
      host: z.string(),
      grootVersion: z.string(),
    })
    .strict(),
  z.object({ ...RecordBase, type: z.literal("operation.resumed"), pid: z.number().int() }).strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("step.intent"),
      stepId: z.string(),
      before: PathHashes,
      /** Backups (relative to the operation dir) of files about to change. */
      backups: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("step.done"),
      stepId: z.string(),
      outcome: z.enum(["applied", "already-applied", "reconciled"]),
      after: PathHashes,
      /** Paths this step created (rollback may delete them when unchanged). */
      created: z.array(RelPath),
      logRef: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("step.failed"),
      stepId: z.string(),
      error: ErrorInfo,
      logRef: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("operation.interrupted"),
      stepId: z.string().nullable(),
      signal: z.string(),
    })
    .strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("operation.completed"),
      evidence: z.array(z.string()),
    })
    .strict(),
  z.object({ ...RecordBase, type: z.literal("operation.failed"), error: ErrorInfo }).strict(),
  z.object({ ...RecordBase, type: z.literal("rollback.started"), pid: z.number().int() }).strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("rollback.step"),
      stepId: z.string(),
      outcome: z.enum(["restored", "deleted", "nothing-to-do", "irreversible"]),
      paths: z.array(RelPath),
    })
    .strict(),
  z
    .object({
      ...RecordBase,
      type: z.literal("rollback.conflict"),
      stepId: z.string(),
      paths: z.array(RelPath),
      reason: z.string(),
    })
    .strict(),
  z.object({ ...RecordBase, type: z.literal("rollback.completed") }).strict(),
]);
export type JournalRecord = z.infer<typeof JournalRecord>;

export const OperationStatus = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "conflicted",
  "rolling-back",
  "rolled-back",
  "rollback-conflicted",
]);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const StepStatus = z.enum(["pending", "running", "done", "failed", "rolled-back"]);

export const StepState = z
  .object({
    id: z.string(),
    type: z.string(),
    description: z.string(),
    status: StepStatus,
    outcome: z.string().nullable(),
    reversible: z.boolean(),
  })
  .strict();
export type StepState = z.infer<typeof StepState>;

/** Derived snapshot of an operation (rebuilt from the journal when in doubt). */
export const OperationState = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.operation"),
    operationId: OperationId,
    planId: PlanId,
    planFingerprint: Sha256,
    intent: PlanIntent,
    summary: z.string(),
    status: OperationStatus,
    startedAt: IsoDate,
    updatedAt: IsoDate,
    steps: z.array(StepState),
    currentStep: z.string().nullable(),
    error: ErrorInfo.nullable(),
    evidence: z.array(z.string()),
    /** Resume can continue from the last checkpoint. */
    resumable: z.boolean(),
    journal: RelPath,
  })
  .strict();
export type OperationState = z.infer<typeof OperationState>;

export const RollbackStepPreview = z
  .object({
    stepId: z.string(),
    description: z.string(),
    action: z.enum(["restore", "delete", "nothing-to-do", "irreversible", "conflict"]),
    paths: z.array(RelPath),
    reason: z.string(),
  })
  .strict();

export const RollbackPreview = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.rollback"),
    operationId: OperationId,
    possible: z.boolean(),
    steps: z.array(RollbackStepPreview),
    conflicts: z.array(RelPath),
    irreversible: z.array(z.string()),
    limits: z.array(z.string()),
  })
  .strict();
export type RollbackPreview = z.infer<typeof RollbackPreview>;

export const OperationResult = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.operation-result"),
    operationId: OperationId,
    planId: PlanId,
    status: OperationStatus,
    /** True when this plan had already completed — nothing was executed again. */
    alreadyApplied: z.boolean(),
    steps: z.array(StepState),
    evidence: z.array(z.string()),
    nextSteps: z.array(z.string()),
    error: ErrorInfo.nullable(),
  })
  .strict();
export type OperationResult = z.infer<typeof OperationResult>;
