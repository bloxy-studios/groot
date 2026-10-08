/**
 * Rollback execution: carry out a conflict-free undo plan (rollback.ts) step
 * by step, newest first, journaling `rollback.step` after each. Every path is
 * re-verified just before it is touched — humans don't take Groot's lock, so
 * an edit made during the rollback becomes `rollback.conflict` (status
 * rollback-conflicted) instead of being overwritten. A later `groot rollback`
 * continues where this one stopped.
 *
 * Directory trees are removed with two guards: the project root itself is
 * never deleted (only its contents), and the root's `.groot/` (Groot's state)
 * and `.git/` (the user's history) always survive.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RollbackPreview, Sha256 } from "../contracts/index.ts";
import { GrootV2Error } from "../errors.ts";
import { resolveInProject } from "../fs/paths.ts";
import { STATE_DIR_NAME } from "../state.ts";
import {
  backupBytes,
  backupMode,
  currentHash,
  EMPTY_TREE_HASH,
  parseKey,
  removeCreatedDirs,
  removePath,
  restoreFile,
} from "./fsops.ts";
import { operationFile } from "./journal.ts";
import { checkpoint, type Execution, emit } from "./runner.ts";
import { abortReason } from "./step-context.ts";

export interface UndoItem {
  /** Tracked key (file path or `tree:<dir>`). */
  readonly key: string;
  /** Hashes the key may have now for the undo to be safe. */
  readonly expected: readonly (Sha256 | null)[];
  /** Hash it goes back to (null = remove it). */
  readonly restoreTo: Sha256 | null;
  /** Backup path relative to the operation directory. */
  readonly backup: string | undefined;
}

export interface StepUndo {
  readonly stepId: string;
  readonly description: string;
  readonly action: RollbackPreview["steps"][number]["action"];
  readonly paths: readonly string[];
  readonly reason: string;
  readonly items: readonly UndoItem[];
  /** Directories the step created (removed when empty after the undo). */
  readonly createdDirs: readonly string[];
  /** Undoing it requires the compensating install (deps.add / install commands). */
  readonly compensates: boolean;
  /** A previous (interrupted) rollback already undid it. */
  readonly alreadyUndone?: boolean;
}

/** Entries of the project root that rollback never removes. */
const ROOT_KEEP = [STATE_DIR_NAME, ".git"];

/** Remove a tree Groot produced; the project root keeps itself, .groot/, and .git/. */
function clearTree(root: string, path: string): void {
  if (path !== ".") {
    removePath(root, path);
    return;
  }
  for (const entry of readdirSync(root)) {
    if (!ROOT_KEEP.includes(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  }
}

function undoTree(ex: Execution, item: UndoItem, path: string): void {
  clearTree(ex.sc.root, path);
  if (item.restoreTo === null) return;
  const target = resolveInProject(ex.sc.root, path);
  mkdirSync(target, { recursive: true });
  // A content-free tree (e.g. the empty directory a generator filled) needs no backup.
  if (item.restoreTo === EMPTY_TREE_HASH || item.backup === undefined) return;
  const backup = operationFile(ex.sc.paths, item.backup);
  for (const entry of readdirSync(backup)) {
    cpSync(join(backup, entry), join(target, entry), { recursive: true, verbatimSymlinks: true });
  }
}

function undoFile(ex: Execution, stepId: string, item: UndoItem, path: string): void {
  if (item.restoreTo === null) {
    removePath(ex.sc.root, path);
    return;
  }
  const bytes =
    item.backup === undefined
      ? null
      : backupBytes(ex.sc.paths, stepId, item.backup, path, item.restoreTo, ex.sc.secrets);
  if (bytes === null || item.backup === undefined) {
    throw new GrootV2Error(
      "GROOT_E_ROLLBACK_CONFLICT",
      `The backup of ${path} can no longer be restored exactly.`,
      {
        details: { operationId: ex.sc.operationId, stepId, path },
      },
    );
  }
  const mode = backupMode(ex.sc.paths, stepId, path, operationFile(ex.sc.paths, item.backup));
  restoreFile(ex.sc.root, path, bytes, mode);
}

/** Re-verify every path of a step right before touching it; journal a conflict if one moved. */
async function verifyStillSafe(ex: Execution, undo: StepUndo): Promise<void> {
  const moved: string[] = [];
  for (const item of undo.items) {
    if (!item.expected.includes(await currentHash(ex.sc.root, item.key))) {
      moved.push(parseKey(item.key).path);
    }
  }
  if (moved.length === 0) return;
  const reason = "changed while the rollback was running";
  ex.journal.append({ type: "rollback.conflict", stepId: undo.stepId, paths: moved, reason });
  checkpoint(ex);
  throw new GrootV2Error(
    "GROOT_E_ROLLBACK_CONFLICT",
    `Rollback stopped at ${undo.stepId}: ${moved.join(", ")} ${reason}. Steps already undone stay undone.`,
    {
      hint: `Resolve those edits, then \`groot rollback ${ex.sc.operationId}\` continues from here.`,
      details: { operationId: ex.sc.operationId, stepId: undo.stepId, conflicts: moved },
    },
  );
}

async function undoStep(ex: Execution, undo: StepUndo): Promise<void> {
  await verifyStillSafe(ex, undo);
  for (const item of undo.items) {
    const parsed = parseKey(item.key);
    if (parsed.kind === "tree") undoTree(ex, item, parsed.path);
    else undoFile(ex, undo.stepId, item, parsed.path);
  }
  removeCreatedDirs(ex.sc.root, undo.createdDirs);
}

/**
 * Undo the steps of a conflict-free plan (newest first). Returns true when a
 * dependency change or install was undone (the caller runs the compensation).
 */
export async function executeRollbackSteps(
  ex: Execution,
  undos: readonly StepUndo[],
): Promise<boolean> {
  let compensate = false;
  for (const undo of undos) {
    if (ex.sc.ctx.signal.aborted) {
      throw new GrootV2Error(
        "GROOT_E_INTERRUPTED",
        `Rollback interrupted (${abortReason(ex.sc.ctx.signal)}) before ${undo.stepId}.`,
        {
          hint: `\`groot rollback ${ex.sc.operationId}\` continues where it stopped.`,
          details: { operationId: ex.sc.operationId, stepId: undo.stepId },
        },
      );
    }
    if (undo.alreadyUndone) continue;
    if (undo.action === "restore" || undo.action === "delete") {
      await undoStep(ex, undo);
      compensate ||= undo.compensates;
    }
    const outcome =
      undo.action === "irreversible"
        ? "irreversible"
        : undo.action === "restore"
          ? "restored"
          : undo.action === "delete"
            ? "deleted"
            : "nothing-to-do";
    ex.journal.append({
      type: "rollback.step",
      stepId: undo.stepId,
      outcome,
      paths: [...undo.paths],
    });
    checkpoint(ex);
    emit(ex, {
      type: "rollback.step",
      level: outcome === "nothing-to-do" ? "debug" : "info",
      stepId: undo.stepId,
      message: `${undo.stepId} ${outcome}${undo.paths.length > 0 ? `: ${undo.paths.join(", ")}` : ""}`,
    });
  }
  return compensate;
}
