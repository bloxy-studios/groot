/**
 * Contract registry: every versioned v2 document, by published name. Drives
 * schema generation (scripts/generate-schemas.ts → schemas/v2/<name>.schema.json),
 * `groot schema` discovery for agents, and the MCP schema resource.
 */
import { z } from "zod";
import { BlueprintV2, ManifestV1 } from "./blueprint.ts";
import { CapabilityDescriptor, RecipeDescriptor, SolverResult } from "./capability.ts";
import { schemaUrl } from "./common.ts";
import { SyncFileChange, TaskContext } from "./context.ts";
import { BlockedDecision, ErrorInfo, GrootEvent, ResultEnvelope } from "./envelope.ts";
import { Evidence, VerificationReport } from "./evidence.ts";
import { GrootLock } from "./lock.ts";
import { JournalRecord, OperationResult, OperationState, RollbackPreview } from "./operation.ts";
import { OperationPlan, PlanIntent } from "./plan.ts";
import { ProjectObservation } from "./project.ts";
import { Review, RunnerCapabilities, Task } from "./task.ts";

export interface ContractEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: z.ZodType;
}

export const CONTRACTS: readonly ContractEntry[] = [
  {
    name: "blueprint",
    title: "groot.json v2 (blueprint)",
    description:
      "Portable desired state: apps, capabilities, decisions, environment, verification, context, policy.",
    schema: BlueprintV2,
  },
  {
    name: "manifest-v1",
    title: "groot.json v1 (manifest)",
    description:
      "The v1 manifest — still read by add/doctor; migrated explicitly by `groot migrate`.",
    schema: ManifestV1,
  },
  {
    name: "lock",
    title: "groot.lock.json",
    description: "Exact generator/recipe resolution and Groot-owned artifacts.",
    schema: GrootLock,
  },
  {
    name: "project",
    title: "Project observation",
    description:
      "Read-only discovery output (`groot inspect`): facts with provenance, confidence, and freshness.",
    schema: ProjectObservation,
  },
  {
    name: "capability",
    title: "Capability descriptor",
    description: "A product or operational result and its recipes.",
    schema: CapabilityDescriptor,
  },
  {
    name: "recipe",
    title: "Recipe descriptor",
    description: "Requirements, conflicts, exact versions, env contracts, verification, recovery.",
    schema: RecipeDescriptor,
  },
  {
    name: "solver-result",
    title: "Compatibility resolution",
    description: "Selected recipes in application order, or refusals with alternatives.",
    schema: SolverResult,
  },
  {
    name: "plan-intent",
    title: "Plan intent",
    description:
      "What a plan was asked to do (init, adopt, migrate, add-capability, context-sync).",
    schema: PlanIntent,
  },
  {
    name: "plan",
    title: "Operation plan",
    description:
      "Concrete actions, preconditions, ownership, environment, verification, recovery limits.",
    schema: OperationPlan,
  },
  {
    name: "journal-record",
    title: "Journal record",
    description: "One append-only line of an operation journal.",
    schema: JournalRecord,
  },
  {
    name: "operation",
    title: "Operation state",
    description: "Derived snapshot of an operation (status, steps, resumability).",
    schema: OperationState,
  },
  {
    name: "operation-result",
    title: "Operation result",
    description: "Outcome of apply/resume/rollback.",
    schema: OperationResult,
  },
  {
    name: "rollback",
    title: "Rollback preview",
    description: "Per-step recovery actions, conflicts, and irreversible effects.",
    schema: RollbackPreview,
  },
  {
    name: "evidence",
    title: "Evidence",
    description: "One check outcome tied to revision, environment, timing, and artifacts.",
    schema: Evidence,
  },
  {
    name: "verification",
    title: "Verification report",
    description: "Structural/build/runtime/product-flow summaries plus evidence.",
    schema: VerificationReport,
  },
  {
    name: "context",
    title: "Task context",
    description: "Concise task-scoped project knowledge (names only, never secret values).",
    schema: TaskContext,
  },
  {
    name: "context-sync-change",
    title: "Context sync change",
    description: "One managed-instruction file change previewed by `groot context sync`.",
    schema: SyncFileChange,
  },
  {
    name: "task",
    title: "Agent task",
    description:
      "Bounded work for an installed coding agent, with attempts, usage, evidence, review, integration.",
    schema: Task,
  },
  {
    name: "review",
    title: "Task review",
    description: "Diff summary, acceptance results, ownership violations, verdict.",
    schema: Review,
  },
  {
    name: "runner",
    title: "Runner capabilities",
    description: "Installed agent discovery: executable, version, auth, supported features.",
    schema: RunnerCapabilities,
  },
  {
    name: "result",
    title: "Result envelope",
    description: "The single stdout document of every v2 command with --json.",
    schema: ResultEnvelope,
  },
  {
    name: "error",
    title: "Error",
    description: "Structured error with a stable GROOT_E_* identifier and exit code.",
    schema: ErrorInfo,
  },
  {
    name: "blocked-decision",
    title: "Blocked decision",
    description: "A choice or prerequisite returned instead of prompting.",
    schema: BlockedDecision,
  },
  {
    name: "event",
    title: "Progress event",
    description: "One stderr JSONL progress event (--events).",
    schema: GrootEvent,
  },
];

/** Look up a contract by published name. */
export function findContract(name: string): ContractEntry | undefined {
  return CONTRACTS.find((entry) => entry.name === name);
}

/** JSON Schema (draft-07) for a contract, with its published $id. */
export function contractJsonSchema(entry: ContractEntry): Record<string, unknown> {
  const generated = z.toJSONSchema(entry.schema, {
    target: "draft-7",
    unrepresentable: "any",
    io: "output",
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: schemaUrl(entry.name),
    title: entry.title,
    description: entry.description,
  };
}

export * from "./blueprint.ts";
export * from "./capability.ts";
export * from "./common.ts";
export * from "./context.ts";
export * from "./envelope.ts";
export * from "./evidence.ts";
export * from "./lock.ts";
export * from "./operation.ts";
export * from "./plan.ts";
export * from "./project.ts";
export * from "./task.ts";
