/**
 * previewRollback / rollbackOperation — undo an operation's recorded effects.
 *
 * Steps are undone in reverse order. A path is restored (from its journaled
 * backup) or deleted (when it was absent before) only if its current hash is
 * exactly what Groot recorded after applying it; anything else is a conflict
 * — a later human edit is never overwritten. The preview simulates the
 * reverse walk (a path a later step restores is compared in its restored
 * state), so it can decide before anything changes; execution refuses with
 * GROOT_E_ROLLBACK_CONFLICT if any conflict exists, then re-verifies each
 * path just before touching it. Irreversible steps are reported, not undone.
 * When dependency changes or installs are undone, `bun install --no-save`
 * re-syncs node_modules with the restored manifests (the compensating
 * command; --no-save so no lockfile appears that wasn't there before). It is
 * held to the action policy like the planner's own install step: when the
 * policy (plus this run's approvals) refuses its classes, the rollback is
 * refused before anything changes (GROOT_E_POLICY_DENIED). A rollback that
 * needs no install never reads the policy.
 */
import { hostname } from "node:os";
import type { Policy } from "../contracts/blueprint.ts";
import type { ActionClass, Sha256 } from "../contracts/common.ts";
import { schemaUrl } from "../contracts/common.ts";
import {
  type OperationResult,
  RollbackPreview as PreviewSchema,
  OperationResult as ResultSchema,
  type RollbackPreview,
} from "../contracts/operation.ts";
import type { PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { acquireProjectLock } from "../fs/lock.ts";
import { runProcess, tail } from "../process.ts";
import type { CoreContext } from "../runtime.ts";
import {
  absentAtIntent,
  backupBytes,
  concealedIn,
  currentHash,
  EMPTY_TREE_HASH,
  parseKey,
  pathKind,
} from "./fsops.ts";
import { operationFile, progressOf, type Replay } from "./journal.ts";
import { deniedAmong } from "./policy.ts";
import { realRoot } from "./project.ts";
import { loadProjectPolicy } from "./project-policy.ts";
import {
  executeRollbackSteps,
  reservedInTree,
  type StepUndo,
  type UndoItem,
} from "./rollback-exec.ts";
import { checkpoint, createExecution, type Execution, emit } from "./runner.ts";
import { childEnv } from "./step-context.ts";
import { isFileStep, plannedAfter } from "./steps.ts";
import { assertStartedPlan, loadOperation, observedStatus, stepStates } from "./store.ts";
import { simulatedTreeHash } from "./tree-sim.ts";

/** The compensating command after dependency changes/installs are undone. */
export const COMPENSATING_INSTALL: readonly string[] = ["bun", "install", "--no-save"];

/**
 * What the policy requires of the compensating install — the classes of the
 * planner's own `bun install` step: it runs a process that installs packages
 * over the network (and dependencies' lifecycle scripts).
 */
export const COMPENSATION_CLASSES: readonly ActionClass[] = ["command", "install", "network"];

/** Wall-time cap for the compensating install. */
const COMPENSATION_TIMEOUT_MS = 600_000;

export interface RollbackOptions {
  /** The action policy (default: the project's, loaded only when the install is needed). */
  readonly policy?: Policy;
  /** Classes approved for this run only; approvals given to apply or resume never carry over. */
  readonly approvals?: readonly ActionClass[];
}

/** Simulated current hashes during the reverse walk (lazily read from disk). */
class Simulation {
  private readonly values = new Map<string, Sha256 | null>();

  constructor(private readonly root: string) {}

  async hash(key: string): Promise<Sha256 | null> {
    if (this.values.has(key)) return this.values.get(key) ?? null;
    const parsed = parseKey(key);
    const value =
      parsed.kind === "tree"
        ? await simulatedTreeHash(this.root, parsed.path, this.values)
        : await currentHash(this.root, key);
    return value;
  }

  set(key: string, hash: Sha256 | null): void {
    this.values.set(key, hash);
  }
}

function compensates(action: PlannedAction): boolean {
  if (action.type === "deps.add") return true;
  return (
    action.type === "command.run" &&
    (action.purpose === "install" || action.classes.includes("install"))
  );
}

function backupUsable(ex: Execution, stepId: string, item: UndoItem): boolean {
  if (item.restoreTo === null) return true;
  const parsed = parseKey(item.key);
  if (parsed.kind === "tree" && item.restoreTo === EMPTY_TREE_HASH) return true;
  if (item.backup === undefined) return false;
  if (parsed.kind === "tree") return pathKind(operationFile(ex.sc.paths, item.backup)) === "dir";
  return (
    backupBytes(ex.sc.paths, stepId, item.backup, parsed.path, item.restoreTo, ex.sc.secrets) !==
    null
  );
}

/** Undo items for a step: what each tracked key must be now, and what it goes back to. */
function undoItems(ex: Execution, action: PlannedAction, replayed: Replay): UndoItem[] {
  const progress = progressOf(replayed, action.id);
  const intent = progress.intent;
  if (intent === null) return [];
  if (progress.phase === "done" && progress.done !== null) {
    const after = progress.done.after;
    return Object.keys(after).map((key) => ({
      key,
      expected: [after[key] ?? null],
      restoreTo: intent.before[key] ?? null,
      backup: intent.backups[key],
    }));
  }
  // In flight / failed: the files may hold the before state or the planned result.
  const planned = isFileStep(action) ? plannedAfter(ex.sc, action, intent) : null;
  return Object.keys(intent.before).map((key) => {
    const before = intent.before[key] ?? null;
    const plannedHash = planned === null ? undefined : planned[key];
    return {
      key,
      expected: plannedHash === undefined ? [before] : [before, plannedHash],
      restoreTo: before,
      backup: intent.backups[key],
    };
  });
}

interface Evaluation {
  readonly conflicts: string[];
  readonly changes: UndoItem[];
  /** Conflicts that are not later edits → why (an unrestorable backup, a .git in the way). */
  readonly explained: ReadonlyMap<string, string>;
}

/** Why the backup of `path` cannot be restored exactly. */
function unrestorable(ex: Execution, stepId: string, path: string): string {
  const quoted = concealedIn(ex.sc.paths, stepId, path);
  return quoted.length === 0
    ? `the backup of ${path} is missing or damaged`
    : `the backup of ${path} quotes ${quoted.map((ref) => `${ref.name} (${ref.path})`).join(", ")}, whose value changed or is gone — put it back to roll back`;
}

/**
 * Compare each item with the simulated current state. Safe changes advance
 * the simulation (the path now holds what the undo restores); conflicts leave
 * it as is, so earlier steps touching the same path conflict too.
 */
async function evaluateItems(
  ex: Execution,
  stepId: string,
  items: readonly UndoItem[],
  sim: Simulation,
): Promise<Evaluation> {
  const conflicts: string[] = [];
  const changes: UndoItem[] = [];
  const explained = new Map<string, string>();
  for (const item of items) {
    const current = await sim.hash(item.key);
    const path = parseKey(item.key).path;
    if (!item.expected.includes(current)) {
      conflicts.push(path);
      continue;
    }
    if (current === item.restoreTo) continue;
    // Undoing a tree clears it first: a .git/.groot inside (invisible to tree
    // hashes) would go with it, and Groot never deletes one.
    const reserved = reservedInTree(ex.sc.root, item.key);
    if (reserved.length > 0) {
      const why = `${reserved.join(", ")} would be deleted with ${path}, and Groot never deletes a .git or .groot directory — move it out first`;
      for (const inside of reserved) explained.set(inside, why);
      conflicts.push(...reserved);
      continue;
    }
    if (!backupUsable(ex, stepId, item)) {
      explained.set(path, unrestorable(ex, stepId, path));
      conflicts.push(path);
      continue;
    }
    changes.push({ ...item, expected: [current] });
    sim.set(item.key, item.restoreTo);
  }
  return { conflicts, changes, explained };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Turn an evaluation into the step's undo decision. */
function decide(
  base: Pick<StepUndo, "stepId" | "description" | "compensates">,
  evaluation: Evaluation,
  completed: boolean,
  createdDirs: readonly string[],
): StepUndo {
  const { conflicts, changes, explained } = evaluation;
  const none = { paths: [], items: [], createdDirs: [] };
  if (conflicts.length > 0) {
    const edited = completed
      ? "changed since groot applied this step; it will not be overwritten"
      : "this step was interrupted and its files match neither their state before it nor its result; resume (or restore them) first";
    const reasons = [
      ...(conflicts.some((path) => !explained.has(path)) ? [edited] : []),
      ...new Set(explained.values()),
    ];
    return { ...base, ...none, action: "conflict", paths: conflicts, reason: reasons.join("; ") };
  }
  if (changes.length === 0) {
    return {
      ...base,
      ...none,
      action: "nothing-to-do",
      reason: "no recorded change to undo",
      createdDirs,
    };
  }
  const deletes = changes.filter((item) => item.restoreTo === null).length;
  const restores = changes.length - deletes;
  const reason = [
    restores > 0 ? `restore ${plural(restores, "path")} from backup` : "",
    deletes > 0 ? `delete ${plural(deletes, "created path")}` : "",
  ];
  return {
    ...base,
    action: restores > 0 ? "restore" : "delete",
    paths: changes.map((item) => parseKey(item.key).path),
    reason: reason.filter((part) => part !== "").join(", "),
    items: changes,
    createdDirs,
  };
}

async function previewStep(
  ex: Execution,
  action: PlannedAction,
  replayed: Replay,
  sim: Simulation,
): Promise<StepUndo> {
  const progress = progressOf(replayed, action.id);
  const base = {
    stepId: action.id,
    description: action.description,
    compensates: compensates(action),
  };
  const none = { paths: [], items: [], createdDirs: [] };
  if (!action.reversible) {
    return { ...base, ...none, action: "irreversible", reason: action.compensation };
  }
  if (progress.phase === "rolled-back" || progress.rollback !== null) {
    return {
      ...base,
      ...none,
      action: "nothing-to-do",
      reason: "already rolled back",
      alreadyUndone: true,
    };
  }
  const items = undoItems(ex, action, replayed);
  const keyPaths = new Set(items.map((item) => parseKey(item.key).path));
  // Directories absent at intent count too: an in-flight step has no done
  // record, and a command creates its touched files' directories unreported.
  const createdDirs = [
    ...new Set([...(progress.done?.created ?? []), ...absentAtIntent(ex.sc.paths, action.id)]),
  ].filter((path) => !keyPaths.has(path));
  const evaluation = await evaluateItems(ex, action.id, items, sim);
  return decide(base, evaluation, progress.phase === "done", createdDirs);
}

/** Every step that ran, newest first, with its undo decision. */
async function planUndo(ex: Execution, replayed: Replay): Promise<StepUndo[]> {
  const sim = new Simulation(ex.sc.root);
  const ran = ex.sc.plan.actions.filter(
    (action) => progressOf(replayed, action.id).intent !== null,
  );
  const undos: StepUndo[] = [];
  for (const action of [...ran].reverse()) undos.push(await previewStep(ex, action, replayed, sim));
  return undos;
}

/** Undoing these steps needs the compensating install (a dependency change or install is undone). */
function needsCompensation(undos: readonly StepUndo[]): boolean {
  return undos.some(
    (undo) => undo.compensates && (undo.action === "restore" || undo.action === "delete"),
  );
}

function toPreview(ex: Execution, undos: readonly StepUndo[]): RollbackPreview {
  const conflicts = [
    ...new Set(undos.filter((undo) => undo.action === "conflict").flatMap((undo) => undo.paths)),
  ];
  const irreversible = undos
    .filter((undo) => undo.action === "irreversible")
    .map((undo) => `${undo.stepId}: ${undo.description} — ${undo.reason}`);
  const limits = [
    ...ex.sc.plan.recovery.limits,
    ...(needsCompensation(undos)
      ? [
          `compensating command: \`${COMPENSATING_INSTALL.join(" ")}\` re-syncs node_modules with the restored manifests (action classes ${COMPENSATION_CLASSES.join(", ")}, held to the project policy)`,
        ]
      : []),
  ];
  return PreviewSchema.parse({
    $schema: schemaUrl("rollback"),
    schemaVersion: 1,
    kind: "groot.rollback",
    operationId: ex.sc.operationId,
    possible: conflicts.length === 0,
    steps: undos.map((undo) => ({
      stepId: undo.stepId,
      description: undo.description,
      action: undo.action,
      paths: undo.paths,
      reason: undo.reason,
    })),
    conflicts,
    irreversible,
    limits,
  });
}

export async function previewRollback(
  ctx: CoreContext,
  root: string,
  operationId: string,
): Promise<RollbackPreview> {
  const canonical = realRoot(root);
  const loaded = loadOperation(canonical, operationId);
  // Read-only: previews take no lock, so they must never repair the journal.
  const ex = createExecution(ctx, canonical, loaded.plan, loaded.paths, "read");
  return toPreview(ex, await planUndo(ex, loaded.replayed));
}

function rollbackConflict(operationId: string, preview: RollbackPreview): GrootV2Error {
  const why = preview.steps
    .filter((step) => step.action === "conflict")
    .map((step) => `${step.paths.join(", ")}: ${step.reason}`);
  return new GrootV2Error(
    "GROOT_E_ROLLBACK_CONFLICT",
    `Cannot roll back ${operationId} — ${why.join("; ")}. Nothing was changed.`,
    {
      hint: `Resolve those paths, then retry; \`groot rollback ${operationId} --dry-run\` shows the plan.`,
      details: { operationId, conflicts: preview.conflicts, preview },
    },
  );
}

/**
 * Refuse a rollback whose compensating install the policy (plus this run's
 * approvals) does not allow — checked before anything changes.
 */
async function assertCompensationAllowed(
  root: string,
  operationId: string,
  options: RollbackOptions,
): Promise<void> {
  const policy = options.policy ?? (await loadProjectPolicy(root)).policy;
  const denied = deniedAmong(COMPENSATION_CLASSES, policy, options.approvals ?? []);
  if (denied.length === 0) return;
  throw new GrootV2Error(
    "GROOT_E_POLICY_DENIED",
    `Rolling back ${operationId} re-syncs node_modules with \`${COMPENSATING_INSTALL.join(" ")}\`, which needs action classes the project policy does not allow: ${denied.join(", ")}. Nothing was changed.`,
    {
      hint: `Approve them for this run (groot rollback ${operationId} --allow ${denied.join(",")}) or extend policy.allow in groot.json.`,
      details: { denied, operationId, policy },
    },
  );
}

async function compensate(ex: Execution): Promise<string | null> {
  emit(ex, {
    type: "rollback.compensate",
    level: "info",
    message: `Running \`${COMPENSATING_INSTALL.join(" ")}\` to re-sync node_modules.`,
  });
  const result = await runProcess({
    argv: COMPENSATING_INSTALL,
    cwd: ex.sc.root,
    env: childEnv(ex.sc.ctx.env, {}),
    timeoutMs: COMPENSATION_TIMEOUT_MS,
    signal: ex.sc.ctx.signal,
    secrets: ex.sc.secrets.values(),
  });
  if (result.exitCode === 0) return null;
  return `\`${COMPENSATING_INSTALL.join(" ")}\` did not succeed (${result.aborted ? "interrupted" : `exit ${result.exitCode ?? result.signal}`}): ${tail(`${result.stdout}\n${result.stderr}`, 3)} — run \`bun install\` yourself.`;
}

function rollbackResult(ex: Execution, warnings: readonly string[]): OperationResult {
  const replayed = ex.journal.replay();
  return ResultSchema.parse({
    $schema: schemaUrl("operation-result"),
    schemaVersion: 1,
    kind: "groot.operation-result",
    operationId: ex.sc.operationId,
    planId: ex.sc.plan.planId,
    status: replayed.status,
    alreadyApplied: false,
    steps: stepStates(ex.sc.plan, replayed),
    evidence: [...replayed.evidence],
    nextSteps: [...warnings],
    error: null,
  });
}

export async function rollbackOperation(
  ctx: CoreContext,
  root: string,
  operationId: string,
  options: RollbackOptions = {},
): Promise<OperationResult> {
  const canonical = realRoot(root);
  const loaded = loadOperation(canonical, operationId);
  if (observedStatus(canonical, loaded) === "rolled-back") {
    return rollbackResult(createExecution(ctx, canonical, loaded.plan, loaded.paths, "read"), []);
  }
  const lock = acquireProjectLock(canonical, { command: "rollback", operationId });
  try {
    const ex = createExecution(ctx, canonical, loaded.plan, loaded.paths);
    const replayed = ex.journal.replay(); // the read the whole rollback works from
    assertStartedPlan(loaded.plan, replayed, loaded.paths);
    if (replayed.status === "rolled-back") return rollbackResult(ex, []);
    const undos = await planUndo(ex, replayed);
    const preview = toPreview(ex, undos);
    if (!preview.possible) throw rollbackConflict(operationId, preview);
    if (needsCompensation(undos)) await assertCompensationAllowed(canonical, operationId, options);

    ex.journal.append({ type: "rollback.started", pid: process.pid });
    checkpoint(ex);
    emit(ex, {
      type: "rollback.started",
      level: "info",
      message: `Rolling back ${operationId} on ${hostname()}.`,
    });
    const compensationNeeded = await executeRollbackSteps(ex, undos);
    const warning = compensationNeeded ? await compensate(ex) : null;
    ex.journal.append({ type: "rollback.completed" });
    checkpoint(ex);
    emit(ex, { type: "rollback.completed", level: "info", message: `Rolled back ${operationId}.` });
    const notes = [...preview.irreversible.map((entry) => `not undone (irreversible): ${entry}`)];
    return rollbackResult(ex, warning === null ? notes : [warning, ...notes]);
  } finally {
    lock.release();
  }
}
