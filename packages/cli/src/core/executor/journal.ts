/**
 * The operation journal: `.groot/operations/<id>/journal.jsonl`, one
 * JournalRecord per line, appended durably (write + fsync) and validated
 * against the contract before it is written. The journal is the source of
 * truth; `state.json` is a snapshot derived from it by `replay`.
 *
 * Crash model: a record is either fully on disk (terminated by "\n") or it is
 * a torn tail — the unterminated fragment of the line being written when the
 * process died. Readers ignore a torn tail; writers truncate it before
 * appending so the next record never fuses with the fragment. A complete line
 * that fails validation is corruption, not a crash artefact, and is reported.
 */
import { existsSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { ErrorInfo } from "../contracts/envelope.ts";
import { JournalRecord, type OperationStatus } from "../contracts/operation.ts";
import { GrootV2Error } from "../errors.ts";
import { appendLineDurable } from "../fs/atomic.ts";
import { nowIso } from "../ids.ts";
import { STATE_DIR_NAME, statePaths } from "../state.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A record before the journal stamps its sequence number and time. */
export type JournalDraft = DistributiveOmit<JournalRecord, "seq" | "at">;

export type StartedRecord = Extract<JournalRecord, { type: "operation.started" }>;
export type IntentRecord = Extract<JournalRecord, { type: "step.intent" }>;
export type DoneRecord = Extract<JournalRecord, { type: "step.done" }>;
export type RollbackStepRecord = Extract<JournalRecord, { type: "rollback.step" }>;

/** Absolute paths of one operation's files. */
export interface OperationPaths {
  readonly id: string;
  readonly dir: string;
  readonly plan: string;
  readonly journal: string;
  readonly state: string;
  readonly backups: string;
  readonly logs: string;
  /** Project-relative journal path (OperationState.journal). */
  readonly journalRel: string;
}

export function operationPaths(root: string, operationId: string): OperationPaths {
  const dir = statePaths.operation(root, operationId);
  return {
    id: operationId,
    dir,
    plan: join(dir, "plan.json"),
    journal: join(dir, "journal.jsonl"),
    state: join(dir, "state.json"),
    backups: join(dir, "backups"),
    logs: join(dir, "logs"),
    journalRel: `${STATE_DIR_NAME}/operations/${operationId}/journal.jsonl`,
  };
}

export interface JournalRead {
  readonly records: JournalRecord[];
  /** An unterminated final fragment was found (and ignored). */
  readonly tornTail: boolean;
  /** Byte length of the valid, newline-terminated prefix. */
  readonly validBytes: number;
}

/** Read a journal, ignoring a torn final line; corruption elsewhere is an error. */
export function readJournal(path: string): JournalRead {
  if (!existsSync(path)) return { records: [], tornTail: false, validBytes: 0 };
  const text = readFileSync(path, "utf8");
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
  const tornTail = lastNewline !== text.length - 1;
  const records: JournalRecord[] = [];
  const lines = complete === "" ? [] : complete.split("\n");
  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    const parsed = JournalRecord.safeParse(value);
    if (!parsed.success) {
      throw new GrootV2Error(
        "GROOT_E_INVALID_DOCUMENT",
        `The operation journal is corrupt at line ${index + 1} (${path}).`,
        {
          hint: "The journal is append-only; restore it from a backup or start a new operation.",
          details: { path, line: index + 1 },
        },
      );
    }
    records.push(parsed.data);
  });
  return {
    records,
    tornTail,
    validBytes: Buffer.byteLength(lastNewline === -1 ? "" : text.slice(0, lastNewline + 1)),
  };
}

/** Durable, validated appends with monotonically increasing sequence numbers. */
export class Journal {
  private readonly entries: JournalRecord[];

  private constructor(
    readonly path: string,
    existing: readonly JournalRecord[],
    private readonly writable: boolean,
  ) {
    this.entries = [...existing];
  }

  /**
   * Open for appending, truncating a torn tail first so no record fuses with
   * it. Only the writer-lock holder may do this: to anyone else an
   * unterminated last line may be a record a live writer is still appending.
   */
  static open(path: string): Journal {
    const read = readJournal(path);
    if (read.tornTail) truncateSync(path, read.validBytes);
    return new Journal(path, read.records, true);
  }

  /** A read-only view (no lock needed; a torn tail is ignored, never repaired). */
  static view(path: string): Journal {
    return new Journal(path, readJournal(path).records, false);
  }

  get records(): readonly JournalRecord[] {
    return this.entries;
  }

  append(draft: JournalDraft): JournalRecord {
    if (!this.writable) {
      throw new GrootV2Error(
        "GROOT_E_INTERNAL",
        "A read-only journal view cannot be appended to.",
        {
          details: { path: this.path },
        },
      );
    }
    const last = this.entries[this.entries.length - 1];
    const record = JournalRecord.parse({
      ...draft,
      seq: last === undefined ? 0 : last.seq + 1,
      at: nowIso(),
    });
    appendLineDurable(this.path, JSON.stringify(record));
    this.entries.push(record);
    return record;
  }

  replay(): Replay {
    return replay(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export type StepPhase = "pending" | "in-flight" | "done" | "failed" | "rolled-back";

export interface StepProgress {
  readonly phase: StepPhase;
  /** Latest intent (before-hashes + backups) for the step. */
  readonly intent: IntentRecord | null;
  readonly done: DoneRecord | null;
  readonly failure: ErrorInfo | null;
  readonly rollback: RollbackStepRecord | null;
}

export interface Replay {
  readonly started: StartedRecord | null;
  readonly status: OperationStatus;
  readonly steps: ReadonlyMap<string, StepProgress>;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly currentStep: string | null;
  readonly error: ErrorInfo | null;
  readonly evidence: readonly string[];
}

const PENDING: StepProgress = {
  phase: "pending",
  intent: null,
  done: null,
  failure: null,
  rollback: null,
};

/** Error ids that mean "the world changed under the plan" rather than "something broke". */
const CONFLICT_ERRORS = new Set([
  "GROOT_E_STALE_PLAN",
  "GROOT_E_CONFLICT",
  "GROOT_E_OWNERSHIP_CONFLICT",
]);

export function progressOf(replayed: Replay, stepId: string): StepProgress {
  return replayed.steps.get(stepId) ?? PENDING;
}

interface Acc {
  started: StartedRecord | null;
  status: OperationStatus;
  steps: Map<string, StepProgress>;
  startedAt: string | null;
  updatedAt: string | null;
  currentStep: string | null;
  error: ErrorInfo | null;
  evidence: readonly string[];
}

function applyStepRecord(acc: Acc, record: JournalRecord): void {
  const step = (id: string): StepProgress => acc.steps.get(id) ?? PENDING;
  switch (record.type) {
    case "step.intent":
      acc.steps.set(record.stepId, { ...PENDING, phase: "in-flight", intent: record });
      acc.currentStep = record.stepId;
      return;
    case "step.done":
      acc.steps.set(record.stepId, { ...step(record.stepId), phase: "done", done: record });
      acc.currentStep = null;
      return;
    case "step.failed":
      acc.steps.set(record.stepId, {
        ...step(record.stepId),
        phase: "failed",
        failure: record.error,
      });
      acc.currentStep = null;
      return;
    case "rollback.step":
      acc.steps.set(record.stepId, {
        ...step(record.stepId),
        phase: record.outcome === "irreversible" ? step(record.stepId).phase : "rolled-back",
        rollback: record,
      });
      return;
    default:
      return;
  }
}

function applyOperationRecord(acc: Acc, record: JournalRecord): void {
  switch (record.type) {
    case "operation.started":
      acc.started = record;
      acc.status = "running";
      acc.startedAt = record.at;
      return;
    case "operation.resumed":
      acc.status = "running";
      acc.error = null;
      return;
    case "operation.interrupted":
      acc.status = "interrupted";
      return;
    case "operation.completed":
      acc.status = "completed";
      acc.evidence = record.evidence;
      acc.currentStep = null;
      return;
    case "operation.failed":
      acc.status = CONFLICT_ERRORS.has(record.error.id) ? "conflicted" : "failed";
      acc.error = record.error;
      return;
    case "rollback.started":
      acc.status = "rolling-back";
      acc.error = null;
      return;
    case "rollback.conflict":
      acc.status = "rollback-conflicted";
      return;
    case "rollback.completed":
      acc.status = "rolled-back";
      acc.currentStep = null;
      return;
    default:
      applyStepRecord(acc, record);
  }
}

/** Derive operation and per-step progress from journal records (pure). */
export function replay(records: readonly JournalRecord[]): Replay {
  const acc: Acc = {
    started: null,
    status: "running",
    steps: new Map(),
    startedAt: null,
    updatedAt: null,
    currentStep: null,
    error: null,
    evidence: [],
  };
  for (const record of records) {
    applyOperationRecord(acc, record);
    acc.updatedAt = record.at;
  }
  return acc;
}
