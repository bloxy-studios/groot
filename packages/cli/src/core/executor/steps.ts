/**
 * Per-action-type knowledge the step runner, resume, and rollback share:
 * which keys a step tracks (hashed before/after, backed up), which
 * expectations must hold right before it runs, how to perform it, and — for
 * file steps — what its tracked keys hash to once it has applied, so an
 * interrupted step can be reconciled against its postcondition.
 */
import type { Sha256 } from "../contracts/common.ts";
import type { PathHashes } from "../contracts/operation.ts";
import type { PlannedAction } from "../contracts/plan.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { packageJsonPath } from "./action-paths.ts";
import { checkExpectation, checkFreshDir } from "./freshness.ts";
import { backupBytes, pathKind, refusedRemoval, reservedWithin, treeKey } from "./fsops.ts";
import { internalHandler } from "./handlers.ts";
import type { IntentRecord } from "./journal.ts";
import type { StepContext, StepEffect } from "./step-context.ts";
import {
  applyEditOrConflict,
  deleteStep,
  depsStep,
  editStep,
  mergeDependencies,
  moveStep,
  secretStep,
  writeStep,
} from "./steps-files.ts";
import { generatorStep } from "./steps-generator.ts";
import { commandStep, externalBlocked, internalStep } from "./steps-process.ts";
import type { StaleFinding } from "./types.ts";

/** Keys hashed (and backed up when present) around a step. */
export function trackedKeys(root: string, action: PlannedAction): string[] {
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "env.secret":
      return [action.path];
    case "file.delete":
      return pathKind(resolveInProject(root, action.path)) === "dir"
        ? [treeKey(action.path)]
        : [action.path];
    case "file.move":
      return [action.from, action.to];
    case "deps.add":
      return [packageJsonPath(action.unit)];
    case "command.run":
    case "internal":
      return [...new Set(action.touches)];
    case "generator.run":
      return [treeKey(action.produces)];
    case "external":
      return [];
  }
}

/** Expectations that must hold right before the step (human edits since planning → stale). */
export async function stepFindings(
  sc: StepContext,
  action: PlannedAction,
): Promise<StaleFinding[]> {
  const check = (path: string, expect: Parameters<typeof checkExpectation>[2]) =>
    checkExpectation(sc.root, path, expect, sc.produced);
  const findings: (StaleFinding | null)[] = [];
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.delete":
      findings.push(await check(action.path, action.expect));
      break;
    case "file.move":
      findings.push(await check(action.from, action.expect));
      findings.push(await check(action.to, { state: "absent" }));
      break;
    case "deps.add":
      findings.push(await check(packageJsonPath(action.unit), action.expect));
      break;
    case "generator.run":
      findings.push(checkFreshDir(sc.root, action.produces));
      break;
    default:
      break;
  }
  return findings.filter((finding): finding is StaleFinding => finding !== null);
}

/**
 * Refusals checked before a step's intent (nothing journaled or backed up):
 * a recursive delete never takes a `.git` or `.groot` with it. Tree hashes
 * ignore those names, so the produced check cannot see a repository a human
 * made inside a generated tree.
 */
export function assertStepSafe(sc: StepContext, action: PlannedAction): void {
  if (action.type !== "file.delete" || !action.recursive) return;
  const reserved = reservedWithin(sc.root, action.path);
  if (reserved.length > 0) throw refusedRemoval(action.path, reserved, action.id);
}

/** Perform a step's effect. */
export async function runEffect(sc: StepContext, action: PlannedAction): Promise<StepEffect> {
  switch (action.type) {
    case "file.write":
      return writeStep(sc, action);
    case "file.edit":
      return editStep(sc, action);
    case "file.delete":
      return deleteStep(sc, action);
    case "file.move":
      return moveStep(sc, action);
    case "deps.add":
      return depsStep(sc, action);
    case "env.secret":
      return secretStep(sc, action);
    case "command.run":
      return commandStep(sc, action);
    case "generator.run":
      return generatorStep(sc, action);
    case "internal":
      return internalStep(sc, action, internalHandler(action.handler));
    case "external":
      throw externalBlocked(action.provider, action.effect, action.id);
  }
}

/** True for steps whose effect is a pure function of the files they track. */
export function isFileStep(action: PlannedAction): boolean {
  return ["file.write", "file.edit", "file.delete", "file.move", "deps.add"].includes(action.type);
}

/** Exact text a tracked file had at intent time (null = absent; undefined = unrecoverable). */
function beforeText(
  sc: StepContext,
  intent: IntentRecord,
  path: string,
): string | null | undefined {
  const hash = intent.before[path];
  if (hash === null || hash === undefined) return null;
  const backup = intent.backups[path];
  if (backup === undefined) return undefined;
  const bytes = backupBytes(sc.paths, intent.stepId, backup, path, hash, sc.secrets);
  return bytes === null ? undefined : Buffer.from(bytes).toString("utf8");
}

/** Hash of `compute(before)`; null-content edits or conflicts mean "cannot have applied". */
function derived(
  sc: StepContext,
  intent: IntentRecord,
  path: string,
  compute: (before: string | null) => string,
): Sha256 | undefined {
  const before = beforeText(sc, intent, path);
  if (before === undefined) return undefined;
  try {
    return sha256Of(compute(before));
  } catch {
    return undefined;
  }
}

/**
 * What a file step's tracked keys hash to once it has applied, given its
 * journaled intent. Null for steps whose result is not a function of their
 * inputs (commands, generators, secrets, internal handlers).
 */
export function plannedAfter(
  sc: StepContext,
  action: PlannedAction,
  intent: IntentRecord,
): PathHashes | null {
  const known = (path: string, hash: Sha256 | null | undefined): PathHashes | null =>
    hash === undefined ? null : { [path]: hash };
  switch (action.type) {
    case "file.write":
      return { [action.path]: action.sha256 };
    case "file.edit":
      if (action.after !== null) return { [action.path]: action.after.sha256 };
      return known(
        action.path,
        derived(sc, intent, action.path, (before) =>
          applyEditOrConflict(before, action.edit, action.path),
        ),
      );
    case "file.delete":
      return Object.fromEntries(Object.keys(intent.before).map((key) => [key, null]));
    case "file.move":
      return { [action.from]: null, [action.to]: intent.before[action.from] ?? null };
    case "deps.add": {
      const path = packageJsonPath(action.unit);
      return known(
        path,
        derived(sc, intent, path, (before) =>
          mergeDependencies(before ?? "", action.changes, path),
        ),
      );
    }
    default:
      return null;
  }
}
