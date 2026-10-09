/**
 * Generator steps and their recovery.
 *
 * Staged generators (the default) run in a fresh directory under the OS
 * tmpdir — a neutral ancestry, v1's runStagedGenerator rationale — and their
 * result is promoted into the project only while the destination is still
 * fresh: a generator can run for minutes and humans don't take Groot's lock,
 * so freshness is checked again right before promotion and an entry that
 * appeared meanwhile is never overwritten. In-place generators write into
 * their destination directly.
 *
 * Recovery must know what a generator left behind, so every generator step
 * keeps a record next to its backups (`backups/<stepId>.generator.json`).
 * Staged promotion writes, before its first rename, every top-level entry it
 * is about to move with a fingerprint of everything that entry holds, and
 * marks the record complete after its last rename; an in-place run records
 * its finished tree. A destination that does not exist yet is created by ONE
 * rename (copied to a sibling first when the stage is on another volume); an
 * existing empty directory or the project root receives entries one by one —
 * so presence alone never proves completion. Resume:
 * - complete record and unchanged tree → the step is done (reconciled);
 * - nothing but entries that still hold exactly what promotion moved there →
 *   remove those and re-run;
 * - anything else — a human's file at a name promotion had not reached yet,
 *   a change inside an entry it moved, an in-place generator's partial
 *   output (which can't be told from a human's) — stops at a retry/skip
 *   decision that names what a retry removes.
 * Recovery never removes `.git` or `.groot`, nested ones included.
 */
import { randomBytes } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { Sha256 } from "../contracts/common.ts";
import type { GeneratorAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { hashFile, hashTree } from "../fs/hash.ts";
import { joinRel, resolveInProject } from "../fs/paths.ts";
import { runProcess, type SpawnResult } from "../process.ts";
import { STATE_DIR_NAME } from "../state.ts";
import { crashPoint } from "./crash.ts";
import { checkFreshDir, staleError } from "./freshness.ts";
import {
  contentEntries,
  ensureParentDirs,
  pathKind,
  readStepRecord,
  removeCreatedDirs,
  removePath,
  reservedWithin,
  treeKey,
  writeStepRecord,
} from "./fsops.ts";
import type { IntentRecord, OperationPaths } from "./journal.ts";
import { reservedName } from "./reserved.ts";
import {
  abortReason,
  childEnv,
  interruptedError,
  type StepContext,
  type StepEffect,
} from "./step-context.ts";
import { failureMessage, writeLog } from "./steps-process.ts";

/** Siblings a cross-volume copy goes through before its rename. */
const PROMOTE_MARK = ".groot-promote-";
const PROMOTE_LEFTOVER = /\.groot-promote-[0-9a-f]{8}$/;
/** The same leftover inside a destination: `<entry>.groot-promote-<hex>`. */
const ENTRY_LEFTOVER = /^(.+)\.groot-promote-[0-9a-f]{8}$/;

const PromotedEntry = z.object({ name: z.string(), fingerprint: z.string() }).strict();

const GeneratorRecord = z
  .object({
    /**
     * Staged: each top-level entry promotion moves into the destination, with
     * the entryFingerprint of what it holds. Empty in place, where partial
     * output cannot be attributed.
     */
    entries: z.array(PromotedEntry),
    /** hashTree of the result. */
    tree: Sha256.nullable(),
    /** Staged: promotion finished. In place: the generator finished. */
    complete: z.boolean(),
  })
  .strict();
type GeneratorRecord = z.infer<typeof GeneratorRecord>;

/**
 * Everything a top-level entry holds — `.git` and `node_modules` included,
 * unlike hashTree's default — so resume treats an entry as the generator's
 * only while it is exactly what promotion moved there.
 */
async function entryFingerprint(abs: string): Promise<string> {
  let info: Stats;
  try {
    info = lstatSync(abs);
  } catch {
    return "absent";
  }
  if (info.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
  if (info.isFile()) return `file:${await hashFile(abs)}`;
  if (info.isDirectory()) return `dir:${await hashTree(abs, [])}`;
  return "other";
}

function writeRecord(paths: OperationPaths, stepId: string, record: GeneratorRecord): void {
  writeStepRecord(paths, stepId, "generator", record);
}

function readRecord(paths: OperationPaths, stepId: string): GeneratorRecord | null {
  const parsed = GeneratorRecord.safeParse(readStepRecord(paths, stepId, "generator"));
  return parsed.success ? parsed.data : null;
}

function generatorFailed(
  sc: StepContext,
  action: GeneratorAction,
  message: string,
  logRef: string,
): GrootV2Error {
  return new GrootV2Error("GROOT_E_GENERATOR", message, {
    hint: `Full output: .groot/operations/${sc.operationId}/${logRef}. Nothing was promoted into ${action.produces}; \`groot resume ${sc.operationId}\` retries the generator.`,
    details: { stepId: action.id, generator: action.generator.package, logRef },
  });
}

async function runGenerator(
  sc: StepContext,
  action: GeneratorAction,
  cwd: string,
): Promise<{ result: SpawnResult; logRef: string }> {
  const result = await runProcess({
    argv: action.argv,
    cwd,
    env: childEnv(sc.ctx.env, {}),
    stdin: action.stdin,
    timeoutMs: action.timeoutMs,
    signal: sc.ctx.signal,
    secrets: sc.secrets.values(),
  });
  return { result, logRef: writeLog(sc, action.id, action.argv, action.cwd, result) };
}

/** Move `src` to `dest` in one rename — through a sibling of `dest` when `src` is on another volume. */
function moveInto(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const sibling = `${dest}${PROMOTE_MARK}${randomBytes(4).toString("hex")}`;
  try {
    cpSync(src, sibling, { recursive: true, verbatimSymlinks: true });
    renameSync(sibling, dest);
  } catch (error) {
    rmSync(sibling, { recursive: true, force: true });
    throw error;
  }
}

function notFresh(sc: StepContext, action: GeneratorAction, path: string): GrootV2Error {
  return staleError(
    [
      {
        path,
        expected: "absent or an empty directory",
        actual: "present",
        reason: "appeared while the generator ran",
      },
    ],
    { planId: sc.plan.planId, operationId: sc.operationId, stepId: action.id },
  );
}

/** Move entries into an existing destination, one by one, never over anything. */
function promoteEntries(
  sc: StepContext,
  action: GeneratorAction,
  grown: string,
  dest: string,
  entries: readonly string[],
): void {
  const moved: string[] = [];
  try {
    for (const entry of entries) {
      const target = join(dest, entry);
      if (pathKind(target) !== "absent")
        throw notFresh(sc, action, joinRel(action.produces, entry));
      moveInto(join(grown, entry), target);
      moved.push(entry);
      if (moved.length === 1) crashPoint(sc.ctx.env, action.id, "mid-promotion");
    }
  } catch (error) {
    for (const entry of moved) rmSync(join(dest, entry), { recursive: true, force: true });
    throw error;
  }
}

/** Promote a staged tree under a promotion record (see the module comment). */
async function promote(
  sc: StepContext,
  action: GeneratorAction,
  grown: string,
  dest: string,
): Promise<void> {
  const stale = checkFreshDir(sc.root, action.produces);
  if (stale !== null) {
    throw staleError([stale], {
      planId: sc.plan.planId,
      operationId: sc.operationId,
      stepId: action.id,
    });
  }
  // .git (when kept) goes last, so a cut-off promotion is unlikely to hold one.
  const names = readdirSync(grown).sort(
    (a, b) => Number(a === ".git") - Number(b === ".git") || (a < b ? -1 : a > b ? 1 : 0),
  );
  const entries: GeneratorRecord["entries"] = [];
  for (const name of names) {
    entries.push({ name, fingerprint: await entryFingerprint(join(grown, name)) });
  }
  const record = { entries, tree: await hashTree(grown), complete: false };
  writeRecord(sc.paths, action.id, record);
  let promoted = false;
  if (action.produces !== ".") {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      moveInto(grown, dest); // also replaces an empty directory where the platform allows it
      promoted = true;
    } catch (error) {
      if (pathKind(dest) !== "dir") throw error;
    }
  }
  if (!promoted) promoteEntries(sc, action, grown, dest, names);
  writeRecord(sc.paths, action.id, { ...record, complete: true });
}

async function stagedGenerator(
  sc: StepContext,
  action: GeneratorAction,
  dest: string,
): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "groot-stage-"));
  try {
    const { result, logRef } = await runGenerator(sc, action, stage);
    if (result.aborted) throw interruptedError(action.id, abortReason(sc.ctx.signal));
    if (result.timedOut || result.exitCode !== 0) {
      throw generatorFailed(
        sc,
        action,
        failureMessage(action.generator.package, result, action.timeoutMs),
        logRef,
      );
    }
    const grown = join(stage, basename(dest));
    if (pathKind(grown) !== "dir") {
      throw generatorFailed(
        sc,
        action,
        `${action.generator.package} finished but produced no "${basename(dest)}" directory.`,
        logRef,
      );
    }
    if (action.scrubGit) rmSync(join(grown, ".git"), { recursive: true, force: true });
    rmSync(join(grown, STATE_DIR_NAME), { recursive: true, force: true }); // never Groot's state
    await promote(sc, action, grown, dest);
    return logRef;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Remove a same-run in-place generator's output: the whole tree, or its entries in a pre-existing dir. */
function removeOutput(root: string, produces: string, existedBefore: boolean): void {
  const abs = resolveInProject(root, produces);
  if (pathKind(abs) === "absent") return;
  if (!existedBefore || pathKind(abs) !== "dir") {
    rmSync(abs, { recursive: true, force: true });
    return;
  }
  for (const entry of contentEntries(abs)) {
    rmSync(join(abs, entry), { recursive: true, force: true });
  }
}

async function inPlaceGenerator(
  sc: StepContext,
  action: GeneratorAction,
  dest: string,
  existedBefore: boolean,
): Promise<string> {
  const hadGit = pathKind(join(dest, ".git")) !== "absent";
  const { result, logRef } = await runGenerator(sc, action, resolveInProject(sc.root, action.cwd));
  if (result.aborted || result.timedOut || result.exitCode !== 0) {
    // Partial in-place output is indistinguishable from complete output: remove it.
    removeOutput(sc.root, action.produces, existedBefore);
    if (result.aborted) throw interruptedError(action.id, abortReason(sc.ctx.signal));
    throw generatorFailed(
      sc,
      action,
      failureMessage(action.generator.package, result, action.timeoutMs),
      logRef,
    );
  }
  if (pathKind(dest) !== "dir") {
    throw generatorFailed(
      sc,
      action,
      `${action.generator.package} finished but did not create ${action.produces}.`,
      logRef,
    );
  }
  if (action.scrubGit && !hadGit) rmSync(join(dest, ".git"), { recursive: true, force: true });
  writeRecord(sc.paths, action.id, { entries: [], tree: await hashTree(dest), complete: true });
  return logRef;
}

export async function generatorStep(sc: StepContext, action: GeneratorAction): Promise<StepEffect> {
  const dest = resolveInProject(sc.root, action.produces);
  const existedBefore = pathKind(dest) === "dir";
  const present = existedBefore ? contentEntries(dest) : [];
  if (present.length > 0) {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${action.produces} is not empty (${present.join(", ")}); the generator needs a fresh directory.`,
      {
        details: {
          path: action.produces,
          paths: present.map((entry) => joinRel(action.produces, entry)),
          conflict: "destination-not-empty",
        },
      },
    );
  }
  const created = action.produces === "." ? [] : ensureParentDirs(sc.root, action.produces);
  let logRef: string;
  try {
    logRef =
      action.mode === "staged"
        ? await stagedGenerator(sc, action, dest)
        : await inPlaceGenerator(sc, action, dest, existedBefore);
  } catch (error) {
    // Each mode removed what it put in place (staged: only what it promoted);
    // drop the parent directories this step created, so a retry starts clean.
    removeCreatedDirs(sc.root, created);
    throw error;
  }
  return {
    outcome: "applied",
    after: { [treeKey(action.produces)]: await hashTree(dest) },
    created,
    logRef,
  };
}

// ---------------------------------------------------------------------------
// Recovery (resume)
// ---------------------------------------------------------------------------

export type GeneratorSettlement =
  | { readonly kind: "done" }
  | { readonly kind: "rerun"; readonly cleanup: () => Promise<void> }
  /** A human must decide (retry/skip): `why` completes "…was interrupted mid-run and …". */
  | { readonly kind: "decide"; readonly why: string; readonly removes: readonly string[] };

/** Cross-volume siblings a cut-off whole-tree promotion left next to the destination. */
function siblingLeftovers(root: string, produces: string): string[] {
  if (produces === ".") return [];
  const dest = resolveInProject(root, produces);
  const parent = dirname(dest);
  if (pathKind(parent) !== "dir") return [];
  const prefix = `${basename(dest)}${PROMOTE_MARK}`;
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && PROMOTE_LEFTOVER.test(name))
    .map((name) => join(parent, name));
}

/** Remove `entries` and leftovers; a destination new since the intent goes when empty. */
function clearDestination(
  root: string,
  produces: string,
  entries: readonly string[],
  existedBefore: boolean,
): void {
  const dest = resolveInProject(root, produces);
  for (const entry of entries) removePath(root, joinRel(produces, entry)); // never .git/.groot
  for (const leftover of siblingLeftovers(root, produces)) {
    rmSync(leftover, { recursive: true, force: true });
  }
  if (!existedBefore && produces !== "." && pathKind(dest) === "dir") {
    if (readdirSync(dest).length === 0) rmdirSync(dest);
  }
}

/** What an incomplete record says promotion moved: entry name → fingerprint. */
function promotedEntries(record: GeneratorRecord | null): ReadonlyMap<string, string> {
  if (record === null || record.complete) return new Map();
  return new Map(record.entries.map((entry) => [entry.name, entry.fingerprint]));
}

/** A cross-volume copy of a promoted entry that a crash left in the destination. */
function isLeftover(entry: string, promoted: ReadonlyMap<string, string>): boolean {
  const base = ENTRY_LEFTOVER.exec(entry)?.[1];
  return base !== undefined && promoted.has(base);
}

/** Present entries that are not exactly what promotion moved there (or its leftovers). */
async function unattributed(
  dest: string,
  present: readonly string[],
  promoted: ReadonlyMap<string, string>,
): Promise<string[]> {
  const foreign: string[] = [];
  for (const entry of present) {
    if (reservedName(entry) !== null) {
      foreign.push(entry); // never Groot's to remove, whoever put it there
      continue;
    }
    if (isLeftover(entry, promoted)) continue;
    const expected = promoted.get(entry);
    if (expected === undefined || (await entryFingerprint(join(dest, entry))) !== expected) {
      foreign.push(entry);
    }
  }
  return foreign;
}

/** Re-running needs the destination cleared, and Groot never deletes a .git or .groot in it. */
function assertClearable(
  sc: StepContext,
  action: GeneratorAction,
  present: readonly string[],
): void {
  const paths = present.flatMap((entry) => {
    const path = joinRel(action.produces, entry);
    return reservedName(entry) !== null ? [path] : reservedWithin(sc.root, path);
  });
  if (paths.length === 0) return;
  throw new GrootV2Error(
    "GROOT_E_CONFLICT",
    `Step ${action.id} cannot run again: ${action.produces} holds ${paths.join(", ")}, and Groot never deletes a .git or .groot directory.`,
    {
      hint: `Move ${paths.join(", ")} out of the way, then \`groot resume ${sc.operationId} --retry-step ${action.id}\` — or keep the result as it is with \`--skip-step ${action.id}\`.`,
      details: { operationId: sc.operationId, stepId: action.id, paths },
    },
  );
}

/**
 * How resume settles an interrupted generator step (see the module comment).
 * `retry`: a human chose to run it again — everything in the destination
 * goes, except that a `.git`/`.groot` anywhere in it is a conflict (Groot
 * never deletes one; the re-run needs a fresh directory).
 */
export async function settleGenerator(
  sc: StepContext,
  action: GeneratorAction,
  intent: IntentRecord,
  retry: boolean,
): Promise<GeneratorSettlement> {
  const dest = resolveInProject(sc.root, action.produces);
  const kind = pathKind(dest);
  const present = kind === "dir" ? contentEntries(dest).sort() : [];
  const record = readRecord(sc.paths, action.id);
  if (!retry && record?.complete === true && kind === "dir") {
    if ((await hashTree(dest)) === record.tree) return { kind: "done" };
  }
  const existedBefore = (intent.before[treeKey(action.produces)] ?? null) !== null;
  const removes = present
    .filter((entry) => reservedName(entry) === null)
    .map((entry) => joinRel(action.produces, entry));
  if (retry) {
    assertClearable(sc, action, present);
    return {
      kind: "rerun",
      cleanup: async () => clearDestination(sc.root, action.produces, present, existedBefore),
    };
  }
  if (kind !== "dir" && kind !== "absent") {
    return { kind: "decide", why: `${action.produces} is no longer a directory`, removes: [] };
  }
  // Only a staged promotion that was cut off says exactly what it moved.
  const promoted = promotedEntries(record);
  const foreign = await unattributed(dest, present, promoted);
  if (record?.complete === true) {
    return {
      kind: "decide",
      why: `its output in ${action.produces} changed after it was written${foreign.length > 0 ? ` (${foreign.join(", ")})` : ""}`,
      removes,
    };
  }
  if (foreign.length > 0) {
    return {
      kind: "decide",
      why: `${action.produces} holds ${foreign.join(", ")}, which Groot cannot attribute to it`,
      removes,
    };
  }
  assertClearable(sc, action, present);
  const cleanup = async (): Promise<void> => {
    // Humans don't take the lock: re-check right before removing anything.
    const now = pathKind(dest) === "dir" ? contentEntries(dest).sort() : [];
    const changed = await unattributed(dest, now, promoted);
    if (changed.length > 0) {
      const paths = changed.map((entry) => joinRel(action.produces, entry));
      throw new GrootV2Error(
        "GROOT_E_CONFLICT",
        `${paths.join(", ")} changed while resume was clearing step ${action.id}'s partial output; nothing was removed.`,
        {
          hint: `Inspect them, then \`groot resume ${sc.operationId}\` decides again.`,
          details: { operationId: sc.operationId, stepId: action.id, paths },
        },
      );
    }
    clearDestination(sc.root, action.produces, now, existedBefore);
  };
  return { kind: "rerun", cleanup };
}
