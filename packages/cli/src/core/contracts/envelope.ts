/**
 * Machine-output contracts shared by every v2 command and MCP tool: the result
 * envelope (stdout), structured errors with stable identifiers, blocked
 * decisions (returned instead of hanging for input), and progress events
 * (stderr JSONL with --events, MCP progress/logging otherwise).
 *
 * v1 commands (init/add/doctor) keep their documented v1 JSON shapes — this
 * envelope applies to the v2 surfaces only.
 */
import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * Stable error identifiers. Agents branch on `id`, never on message text;
 * renaming an id is a breaking change (docs/v2-cli-spec.md#errors).
 */
export const ERROR_IDS = [
  "GROOT_E_INTERNAL",
  "GROOT_E_USAGE",
  "GROOT_E_PREFLIGHT",
  "GROOT_E_GENERATOR",
  "GROOT_E_COMMAND_FAILED",
  "GROOT_E_VERIFY_FAILED",
  "GROOT_E_NOT_A_PROJECT",
  "GROOT_E_NOT_REGISTERED",
  "GROOT_E_MIGRATION_REQUIRED",
  "GROOT_E_UNSUPPORTED_SCHEMA",
  "GROOT_E_INVALID_DOCUMENT",
  "GROOT_E_UNSUPPORTED_PROJECT",
  "GROOT_E_INCOMPATIBLE",
  "GROOT_E_UNKNOWN_CAPABILITY",
  "GROOT_E_STALE_PLAN",
  "GROOT_E_CONFLICT",
  "GROOT_E_OWNERSHIP_CONFLICT",
  "GROOT_E_ROLLBACK_CONFLICT",
  "GROOT_E_PATH_OUTSIDE_PROJECT",
  "GROOT_E_POLICY_DENIED",
  "GROOT_E_BLOCKED",
  "GROOT_E_LOCKED",
  "GROOT_E_INTERRUPTED",
  "GROOT_E_NOT_FOUND",
  "GROOT_E_NOT_RESUMABLE",
  "GROOT_E_RUNNER_UNAVAILABLE",
  "GROOT_E_TASK_STATE",
] as const;
export const ErrorId = z.enum(ERROR_IDS);
export type ErrorId = z.infer<typeof ErrorId>;

export const ErrorInfo = z
  .object({
    id: ErrorId,
    message: z.string(),
    hint: z.string().nullable(),
    exitCode: z.number().int(),
    /** Structured specifics (conflicting paths, alternatives, …). */
    details: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type ErrorInfo = z.infer<typeof ErrorInfo>;

export const DecisionOption = z
  .object({
    id: z.string(),
    label: z.string(),
    effect: z.string(),
    recommended: z.boolean(),
  })
  .strict();

/**
 * A choice or prerequisite that only a human (or a supervising agent) can
 * resolve. Non-interactive runs return these instead of prompting.
 */
export const BlockedDecision = z
  .object({
    id: z.string(),
    kind: z.enum(["decision", "prerequisite", "credential", "policy"]),
    question: z.string(),
    options: z.array(DecisionOption),
    /** Flag, command, or input that resolves it. */
    resolveWith: z.string(),
  })
  .strict();
export type BlockedDecision = z.infer<typeof BlockedDecision>;

export const ResultRefs = z
  .object({
    planId: z.string().nullable(),
    operationId: z.string().nullable(),
    taskId: z.string().nullable(),
    evidence: z.array(z.string()),
  })
  .strict();

/** The single stdout document every v2 command prints with --json. */
export const ResultEnvelope = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.result"),
    command: z.string(),
    ok: z.boolean(),
    data: z.unknown(),
    error: ErrorInfo.nullable(),
    blocked: z.array(BlockedDecision),
    warnings: z.array(z.string()),
    refs: ResultRefs,
    grootVersion: z.string(),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

export const EventLevel = z.enum(["debug", "info", "warn", "error"]);

/** Progress event (stderr JSONL with --events; MCP notifications). */
export const GrootEvent = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("groot.event"),
    type: z.string(),
    at: IsoDate,
    level: EventLevel,
    message: z.string(),
    operationId: z.string().nullable(),
    stepId: z.string().nullable(),
    taskId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type GrootEvent = z.infer<typeof GrootEvent>;
