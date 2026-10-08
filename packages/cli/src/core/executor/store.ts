/**
 * Operation storage under `.groot/operations/<id>/`: the plan copy, the
 * journal, the derived `state.json` snapshot, and read access for status,
 * resume, rollback, and idempotent re-apply.
 *
 * Reads rebuild state from the journal (the source of truth) rather than
 * trusting the snapshot, and correct for liveness: an operation whose journal
 * says "running" but whose writer is gone (no live lock holder) was cut off
 * by a crash and is reported as interrupted and resumable.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OperationId, schemaUrl } from "../contracts/common.ts";
import {
  type OperationState,
  OperationState as OperationStateSchema,
  type OperationStatus,
  type StepState,
} from "../contracts/operation.ts";
import type { OperationPlan, PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { isProcessAlive } from "../fs/lock.ts";
import { nowIso } from "../ids.ts";
import { prettyJson } from "../json.ts";
import { ensureStateDir, stateDir, statePaths } from "../state.ts";
import {
  type OperationPaths,
  operationPaths,
  progressOf,
  type Replay,
  readJournal,
  replay,
  type StepProgress,
} from "./journal.ts";
import { validatePlanDocument } from "./plans.ts";

/** Statuses from which `groot resume` can continue. */
const RESUMABLE: ReadonlySet<OperationStatus> = new Set([
  "running",
  "interrupted",
  "failed",
  "conflicted",
]);

export function isResumableStatus(status: OperationStatus): boolean {
  return RESUMABLE.has(status);
}

export function isOperationId(value: string): boolean {
  return OperationId.safeParse(value).success;
}

/** Create `.groot/operations/<id>/` with the plan copy, backups/, and logs/. */
export function createOperationDir(
  root: string,
  operationId: string,
  plan: OperationPlan,
): OperationPaths {
  ensureStateDir(root);
  const paths = operationPaths(root, operationId);
  mkdirSync(paths.backups, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  writeFileAtomic(paths.plan, prettyJson(plan));
  return paths;
}

function stepState(action: PlannedAction, progress: StepProgress): StepState {
  const base = {
    id: action.id,
    type: action.type,
    description: action.description,
    reversible: action.reversible,
  };
  switch (progress.phase) {
    case "pending":
      return { ...base, status: "pending", outcome: null };
    case "in-flight":
      return { ...base, status: "running", outcome: null };
    case "done":
      return {
        ...base,
        status: "done",
        outcome: progress.rollback?.outcome ?? progress.done?.outcome ?? null,
      };
    case "failed":
      return { ...base, status: "failed", outcome: progress.failure?.id ?? null };
    case "rolled-back":
      return { ...base, status: "rolled-back", outcome: progress.rollback?.outcome ?? null };
  }
}

export function stepStates(plan: OperationPlan, replayed: Replay): StepState[] {
  return plan.actions.map((action) => stepState(action, progressOf(replayed, action.id)));
}

/** The OperationState snapshot for a replayed journal (validated against the contract). */
export function buildState(
  plan: OperationPlan,
  replayed: Replay,
  paths: OperationPaths,
  statusOverride?: OperationStatus,
): OperationState {
  const status = statusOverride ?? replayed.status;
  const now = nowIso();
  return OperationStateSchema.parse({
    $schema: schemaUrl("operation"),
    schemaVersion: 1,
    kind: "groot.operation",
    operationId: paths.id,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    intent: plan.intent,
    summary: plan.summary,
    status,
    startedAt: replayed.startedAt ?? now,
    updatedAt: replayed.updatedAt ?? now,
    steps: stepStates(plan, replayed),
    currentStep: replayed.currentStep,
    error: replayed.error,
    evidence: [...replayed.evidence],
    resumable: isResumableStatus(status),
    journal: paths.journalRel,
  });
}

/** Atomically write state.json for the current journal state. */
export function writeState(
  paths: OperationPaths,
  plan: OperationPlan,
  replayed: Replay,
): OperationState {
  const state = buildState(plan, replayed, paths);
  writeFileAtomic(paths.state, prettyJson(state));
  return state;
}

// ---------------------------------------------------------------------------
// Lock holder
// ---------------------------------------------------------------------------

const LockHolderSchema = z
  .object({
    pid: z.number().int(),
    host: z.string(),
    command: z.string(),
    operationId: z.string().nullable(),
    acquiredAt: z.string(),
  })
  .strict();
export type LockHolderInfo = z.infer<typeof LockHolderSchema>;

/** The current writer-lock holder (core/fs/lock.ts), or null when unlocked/unreadable. */
export function readLockHolder(root: string): LockHolderInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir(root), "lock.json"), "utf8"));
    const parsed = LockHolderSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A holder on this host must be alive; one on another host cannot be checked and counts as live. */
export function isHolderLive(holder: LockHolderInfo): boolean {
  return holder.host !== hostname() || isProcessAlive(holder.pid);
}

function writerIsLive(root: string, operationId: string): boolean {
  const holder = readLockHolder(root);
  return holder !== null && holder.operationId === operationId && isHolderLive(holder);
}

// ---------------------------------------------------------------------------
// Reading operations
// ---------------------------------------------------------------------------

export interface LoadedOperation {
  readonly paths: OperationPaths;
  readonly plan: OperationPlan;
  readonly replayed: Replay;
}

function notFound(operationId: string, detail?: string): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_NOT_FOUND",
    `No operation ${operationId} in this project${detail === undefined ? "" : ` (${detail})`}.`,
    { hint: "List operations with `groot status`.", details: { operationId } },
  );
}

/** Load an operation's plan copy and replayed journal. */
export function loadOperation(root: string, operationId: string): LoadedOperation {
  if (!isOperationId(operationId)) throw notFound(operationId, "not an operation id");
  const paths = operationPaths(root, operationId);
  let planText: string;
  try {
    planText = readFileSync(paths.plan, "utf8");
  } catch {
    throw notFound(operationId);
  }
  let planValue: unknown;
  try {
    planValue = JSON.parse(planText);
  } catch {
    planValue = null;
  }
  const plan = validatePlanDocument(planValue, paths.plan);
  const replayed = replay(readJournal(paths.journal).records);
  if (replayed.started === null) throw notFound(operationId, "it never started");
  return { paths, plan, replayed };
}

/** Status as a reader should see it: a "running" operation without a live writer crashed. */
export function observedStatus(root: string, loaded: LoadedOperation): OperationStatus {
  const status = loaded.replayed.status;
  if (status === "running" && !writerIsLive(root, loaded.paths.id)) return "interrupted";
  return status;
}

function readSnapshot(root: string, operationId: string): OperationState {
  const paths = operationPaths(root, operationId);
  try {
    return OperationStateSchema.parse(JSON.parse(readFileSync(paths.state, "utf8")));
  } catch {
    throw notFound(operationId);
  }
}

export async function readOperation(root: string, operationId: string): Promise<OperationState> {
  let loaded: LoadedOperation;
  try {
    loaded = loadOperation(root, operationId);
  } catch (error) {
    // The journal is authoritative; fall back to the snapshot only if it can't be replayed.
    if (error instanceof GrootV2Error && error.id === "GROOT_E_NOT_FOUND") {
      if (!isOperationId(operationId)) throw error;
      return readSnapshot(root, operationId);
    }
    throw error;
  }
  return buildState(loaded.plan, loaded.replayed, loaded.paths, observedStatus(root, loaded));
}

/** Every operation, newest first (ids are time-sortable). Unreadable directories are skipped. */
export async function listOperations(root: string): Promise<OperationState[]> {
  let ids: string[];
  try {
    ids = readdirSync(statePaths.operations(root));
  } catch {
    return [];
  }
  const states: OperationState[] = [];
  for (const id of ids.filter(isOperationId).sort().reverse()) {
    try {
      states.push(await readOperation(root, id));
    } catch {
      // a partial or foreign directory is not an operation
    }
  }
  return states;
}

/** The newest operation that executed a plan with this fingerprint, if any. */
export async function findByFingerprint(
  root: string,
  fingerprint: string,
): Promise<OperationState | null> {
  const all = await listOperations(root);
  return all.find((state) => state.planFingerprint === fingerprint) ?? null;
}
