/**
 * Operation storage under `.groot/operations/<id>/`: the plan copy, the
 * journal, the derived `state.json` snapshot, and read access for status,
 * resume, rollback, and idempotent re-apply.
 *
 * Reads rebuild state from the journal (the source of truth) rather than
 * trusting the snapshot, and correct for liveness: an operation whose journal
 * says "running" but whose writer is gone (no live lock holder) was cut off
 * by a crash and is reported as interrupted and resumable; one whose writer
 * is alive is running, and not resumable.
 *
 * Operation directories are owner-only (0700, plan copy 0600). The plan copy
 * conceals known secret values like backups do (secrets.ts) and is revealed
 * on load, then must be the plan the journal started — same id and
 * fingerprint — so a swapped copy never runs under another plan's journal.
 * When a value it quotes has changed since (a rotated key), the copy cannot
 * be revealed exactly: it loads "sealed" — still listed, shown, and rolled
 * back with (rollback works from the journal and backups), never resumed.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import { validatePlanDocument, validateSealedPlanDocument } from "./plans.ts";
import {
  concealDocument,
  concealedRefs,
  readSidecar,
  revealDocument,
  type SecretBook,
  type SecretRef,
} from "./secrets.ts";

/** Operation state quotes file contents: only the owner may enter or read it. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Journal statuses from which `groot resume` can continue ("running" under
 * the writer lock means the previous writer crashed).
 */
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

/**
 * Create `.groot/operations/<id>/` (0700) with the plan copy (0600, known
 * secret values concealed), backups/, and logs/.
 */
export function createOperationDir(
  root: string,
  operationId: string,
  plan: OperationPlan,
  secrets: SecretBook,
): OperationPaths {
  ensureStateDir(root);
  const paths = operationPaths(root, operationId);
  for (const dir of [paths.dir, paths.backups, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    chmodSync(dir, PRIVATE_DIR_MODE);
  }
  const { bytes, sidecar } = concealDocument(secrets, prettyJson(plan));
  if (sidecar !== null) {
    writeFileAtomic(paths.planSecrets, prettyJson(sidecar), PRIVATE_FILE_MODE);
  }
  writeFileAtomic(paths.plan, bytes, PRIVATE_FILE_MODE);
  return paths;
}

function parsedJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The plan copy, its concealed values revealed — or, when one changed or is
 * gone, the concealed copy itself ("sealed", with the variables it quotes).
 */
function readPlanCopy(
  root: string,
  paths: OperationPaths,
  bytes: Uint8Array,
): { plan: OperationPlan; sealed: readonly SecretRef[] | null } {
  const sidecar = readSidecar(paths.planSecrets);
  if (sidecar === null)
    return { plan: validatePlanDocument(parsedJson(bytes), paths.plan), sealed: null };
  const revealed = sidecar === "invalid" ? null : revealDocument(root, bytes, sidecar);
  if (revealed !== null) {
    return { plan: validatePlanDocument(parsedJson(revealed), paths.plan), sealed: null };
  }
  return {
    plan: validateSealedPlanDocument(parsedJson(bytes), paths.plan),
    sealed: sidecar === "invalid" ? [] : concealedRefs(sidecar),
  };
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

/**
 * The OperationState snapshot for a replayed journal (validated against the
 * contract). `sealed`: the plan copy cannot be revealed (see the module
 * comment), so the operation is not resumable whatever its status.
 */
export function buildState(
  plan: OperationPlan,
  replayed: Replay,
  paths: OperationPaths,
  statusOverride?: OperationStatus,
  sealed = false,
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
    // "running" here means a live writer (readers turn a dead one's into
    // "interrupted"): resuming it would only meet GROOT_E_LOCKED.
    resumable: !sealed && status !== "running" && isResumableStatus(status),
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
  /**
   * Null when the plan copy was revealed exactly. Otherwise `plan` is the
   * concealed copy and this lists the secret variables (name + env file) it
   * quotes whose values changed or are gone — show it, roll back with it,
   * never run it.
   */
  readonly sealed: readonly SecretRef[] | null;
}

function notFound(operationId: string, detail?: string): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_NOT_FOUND",
    `No operation ${operationId} in this project${detail === undefined ? "" : ` (${detail})`}.`,
    { hint: "List operations with `groot status`.", details: { operationId } },
  );
}

/**
 * A plan copy runs only under the journal that started it: same plan id and
 * fingerprint (checked on load, and again by writers on the journal they
 * re-read under the lock).
 */
export function assertStartedPlan(
  plan: OperationPlan,
  replayed: Replay,
  paths: OperationPaths,
): void {
  if (replayed.started === null) throw notFound(paths.id, "it never started");
  const { planId, planFingerprint } = replayed.started;
  if (plan.planId === planId && plan.fingerprint === planFingerprint) return;
  throw new GrootV2Error(
    "GROOT_E_INVALID_DOCUMENT",
    `The plan copy of operation ${paths.id} is not the plan it started (${planId}).`,
    {
      hint: "The operation's plan.json was replaced or edited; put back the plan it started with (the same plan file or saved plan) to resume or roll it back.",
      details: {
        operationId: paths.id,
        path: paths.plan,
        expected: { planId, fingerprint: planFingerprint },
        actual: { planId: plan.planId, fingerprint: plan.fingerprint },
      },
    },
  );
}

/** Load an operation's plan copy and replayed journal. */
export function loadOperation(root: string, operationId: string): LoadedOperation {
  if (!isOperationId(operationId)) throw notFound(operationId, "not an operation id");
  const paths = operationPaths(root, operationId);
  let planBytes: Uint8Array;
  try {
    planBytes = readFileSync(paths.plan);
  } catch {
    throw notFound(operationId);
  }
  const { plan, sealed } = readPlanCopy(root, paths, planBytes);
  const replayed = replay(readJournal(paths.journal).records);
  assertStartedPlan(plan, replayed, paths);
  return { paths, plan, replayed, sealed };
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
  return buildState(
    loaded.plan,
    loaded.replayed,
    loaded.paths,
    observedStatus(root, loaded),
    loaded.sealed !== null,
  );
}

/**
 * Every operation, newest first (ids are time-sortable). Unreadable operation
 * directories are skipped; a refused state path (a symlinked `.groot`) is an
 * error, never an empty list.
 */
export async function listOperations(root: string): Promise<OperationState[]> {
  let ids: string[];
  try {
    ids = readdirSync(statePaths.operations(root));
  } catch (error) {
    if (error instanceof GrootV2Error) throw error;
    return [];
  }
  const states: OperationState[] = [];
  for (const id of ids.filter(isOperationId).sort().reverse()) {
    try {
      states.push(await readOperation(root, id));
    } catch (error) {
      if (error instanceof GrootV2Error && error.id === "GROOT_E_PATH_OUTSIDE_PROJECT") throw error;
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
