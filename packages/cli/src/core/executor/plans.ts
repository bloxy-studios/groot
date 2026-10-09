/**
 * Plan documents as untrusted input. A plan file can come from anywhere (an
 * agent, a teammate, an MCP client), so before the executor acts on one it is
 * validated against the plan contract AND checked for internal integrity:
 *
 * - the fingerprint must match intent + actions + preconditions — it is the
 *   idempotency key, so a hand-edited plan must never pass for an applied one;
 * - every exact preview (write content, precomputed edit result) must match
 *   its declared hash;
 * - step ids are unique and dependency changes target their own unit;
 * - a `produced` expectation names an EARLIER step that produces exactly that
 *   path (it skips the up-front hash check, so it must not be claimable), and
 *   no precondition expects one (nothing has run when preconditions are checked);
 * - no action names a path inside `.groot/` or `.git/` (reserved.ts).
 *
 * Saved plans live at `.groot/plans/<planId>.json` (mode 0600) so
 * `groot apply <planId>` works without keeping the file around. Like an
 * operation's plan copy, a saved plan conceals the secret values Groot knows
 * (secrets.ts) — an exact preview can quote a file a human copied one into —
 * and `<planId>.secrets.json` says how to put them back. Loading reveals them
 * exactly or reports the plan stale: a value it quotes changed since.
 */
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { z } from "zod";
import { PlanId } from "../contracts/common.ts";
import { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { sha256Of } from "../fs/hash.ts";
import { canonicalJson, prettyJson } from "../json.ts";
import { ensureStateDir, STATE_DIR_NAME, statePaths } from "../state.ts";
import { namedPaths, ownExpectation, producedPath } from "./action-paths.ts";
import { staleError } from "./freshness.ts";
import { describeReserved, reservedName } from "./reserved.ts";
import {
  concealDocument,
  concealedRefs,
  knownSecretRefs,
  readSidecar,
  revealDocument,
  SecretBook,
} from "./secrets.ts";

/** Most issues listed in an INVALID_DOCUMENT error (the rest are counted). */
const MAX_REPORTED_ISSUES = 20;

/** Plan copies can hold file contents; only the owner may read them. */
const PLAN_FILE_MODE = 0o600;

export interface DocumentIssue {
  readonly path: string;
  readonly message: string;
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map((segment) => String(segment)).join(".");
}

function invalid(source: string, issues: readonly DocumentIssue[]): GrootV2Error {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES);
  const summary = shown.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return new GrootV2Error("GROOT_E_INVALID_DOCUMENT", `${source} is not a valid plan: ${summary}`, {
    hint: "Plans are produced by `groot plan` (schemas/v2/plan.schema.json); re-create the plan instead of editing it.",
    details: { source, issues: shown, totalIssues: issues.length },
  });
}

function zodIssues(error: z.ZodError): DocumentIssue[] {
  return error.issues.map((issue) => ({ path: issuePath(issue.path), message: issue.message }));
}

/** Paths inside `.groot/` or `.git/` that an action names. */
function reservedIssues(plan: OperationPlan): DocumentIssue[] {
  return plan.actions.flatMap((action, index) =>
    namedPaths(action).flatMap(({ field, path }) => {
      const reserved = reservedName(path);
      return reserved === null
        ? []
        : [
            {
              path: `actions.${index}.${field}`,
              message: `is inside ${describeReserved(reserved)}`,
            },
          ];
    }),
  );
}

/** `produced` expectations must name an earlier step producing exactly that path. */
function producedIssues(plan: OperationPlan): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  plan.actions.forEach((action, index) => {
    const own = ownExpectation(action);
    if (own === null || own.expect.state !== "produced") return;
    const { byStep } = own.expect;
    const producerIndex = plan.actions.findIndex((candidate) => candidate.id === byStep);
    const producer = producerIndex < index ? plan.actions[producerIndex] : undefined;
    if (producer === undefined) {
      issues.push({
        path: `actions.${index}.expect.byStep`,
        message: `${byStep} is not an earlier step of this plan`,
      });
    } else if (producedPath(producer) !== own.path) {
      issues.push({
        path: `actions.${index}.expect.byStep`,
        message: `step ${byStep} (${producer.type}) does not produce ${own.path}`,
      });
    }
  });
  plan.preconditions.forEach((pre, index) => {
    if (pre.type === "path" && pre.expect.state === "produced") {
      issues.push({
        path: `preconditions.${index}.expect`,
        message:
          "preconditions are checked before any step runs, so none can expect a produced path",
      });
    }
  });
  return issues;
}

/**
 * Integrity problems a schema cannot express (hash/preview consistency,
 * producers, reserved paths). `sealed`: the document's secret values are
 * concealed and cannot be revealed, so what depends on them — content
 * hashes, the fingerprint — cannot be recomputed and is not checked.
 */
function integrityIssues(plan: OperationPlan, sealed = false): DocumentIssue[] {
  const issues: DocumentIssue[] = [...reservedIssues(plan), ...producedIssues(plan)];
  const seen = new Set<string>();
  plan.actions.forEach((action, index) => {
    const at = `actions.${index}`;
    if (seen.has(action.id))
      issues.push({ path: `${at}.id`, message: `duplicate step id ${action.id}` });
    seen.add(action.id);
    if (!sealed && action.type === "file.write" && sha256Of(action.content) !== action.sha256) {
      issues.push({ path: `${at}.sha256`, message: "does not match the content" });
    }
    if (!sealed && action.type === "file.edit" && action.after !== null) {
      if (sha256Of(action.after.content) !== action.after.sha256) {
        issues.push({ path: `${at}.after.sha256`, message: "does not match the content" });
      }
    }
    if (action.type === "deps.add") {
      action.changes.forEach((change, changeIndex) => {
        if (change.unit !== action.unit) {
          issues.push({
            path: `${at}.changes.${changeIndex}.unit`,
            message: `targets ${change.unit} but the step edits ${action.unit}`,
          });
        }
      });
    }
  });
  if (sealed) return issues;
  const fingerprint = sha256Of(
    canonicalJson({
      intent: plan.intent,
      actions: plan.actions,
      preconditions: plan.preconditions,
    }),
  );
  if (fingerprint !== plan.fingerprint) {
    issues.push({
      path: "fingerprint",
      message:
        "does not match intent + actions + preconditions (the plan was modified after planning)",
    });
  }
  return issues;
}

/**
 * Validate an untrusted plan value (parsed JSON, an MCP argument, an
 * in-process object). Throws GROOT_E_INVALID_DOCUMENT listing every issue
 * with its document path.
 */
export function validatePlanDocument(value: unknown, source = "the plan"): OperationPlan {
  const parsed = OperationPlan.safeParse(value);
  if (!parsed.success) throw invalid(source, zodIssues(parsed.error));
  const issues = integrityIssues(parsed.data);
  if (issues.length > 0) throw invalid(source, issues);
  return parsed.data;
}

/**
 * A stored plan document whose concealed secret values can no longer be
 * revealed exactly (a variable changed or went away): checked like any plan
 * except for what depends on those values. Fit to show and to roll back
 * with — never to run (store.ts).
 */
export function validateSealedPlanDocument(value: unknown, source: string): OperationPlan {
  const parsed = OperationPlan.safeParse(value);
  if (!parsed.success) throw invalid(source, zodIssues(parsed.error));
  const issues = integrityIssues(parsed.data, true);
  if (issues.length > 0) throw invalid(source, issues);
  return parsed.data;
}

/** Where a plan document's concealment sidecar lives: `<name>.json` → `<name>.secrets.json`. */
function sidecarPath(documentPath: string): string {
  return `${documentPath.replace(/\.json$/, "")}.secrets.json`;
}

/** The project a saved plan file belongs to (`<root>/.groot/plans/<planId>.json`), or null. */
function savedPlanRoot(path: string): string | null {
  const abs = resolve(path);
  const plans = dirname(abs);
  const state = dirname(plans);
  const name = basename(abs);
  if (basename(plans) !== "plans" || basename(state) !== STATE_DIR_NAME) return null;
  if (!name.endsWith(".json") || !isPlanId(name.slice(0, -".json".length))) return null;
  return dirname(state);
}

/**
 * A saved plan's bytes with its concealed secret values put back from its
 * project's env files (other files are returned as they are). A value that
 * changed since the plan was saved makes it stale.
 */
function revealSavedPlan(path: string, bytes: Uint8Array): Uint8Array {
  const root = savedPlanRoot(path);
  if (root === null) return bytes;
  const sidecar = readSidecar(sidecarPath(path));
  if (sidecar === null) return bytes;
  if (sidecar === "invalid") {
    throw invalid(path, [
      { path: "(root)", message: `its secrets sidecar ${sidecarPath(path)} is unreadable` },
    ]);
  }
  const revealed = revealDocument(root, bytes, sidecar);
  if (revealed !== null) return revealed;
  const planId = basename(path, ".json");
  const findings = concealedRefs(sidecar).map((ref) => ({
    path: ref.path,
    expected: `the value of ${ref.name} the plan quotes`,
    actual: "a different value, or none",
    reason: `${ref.name} changed after the plan was saved`,
  }));
  throw staleError(findings, { planId });
}

/** Read + validate a plan document from a file. */
export async function loadPlanFile(path: string): Promise<OperationPlan> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `No plan file at ${path}.`, {
      hint: "Pass the path of a plan JSON file, or the id of a plan saved under .groot/plans/.",
      details: { path },
    });
  }
  const text = Buffer.from(revealSavedPlan(path, bytes)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalid(path, [
      {
        path: "(root)",
        message: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    ]);
  }
  return validatePlanDocument(value, path);
}

/** Persist a plan (known secret values concealed) under .groot/plans/<planId>.json; returns its path. */
export async function savePlan(root: string, plan: OperationPlan): Promise<string> {
  const valid = validatePlanDocument(plan);
  ensureStateDir(root);
  const path = statePaths.plan(root, valid.planId);
  const secrets = new SecretBook(root, knownSecretRefs(root, valid));
  const { bytes, sidecar } = concealDocument(secrets, prettyJson(valid));
  if (sidecar === null) rmSync(sidecarPath(path), { force: true });
  else writeFileAtomic(sidecarPath(path), prettyJson(sidecar), PLAN_FILE_MODE);
  writeFileAtomic(path, bytes, PLAN_FILE_MODE);
  return path;
}

/** True when `value` has the shape of a plan id (safe to use as a file name). */
export function isPlanId(value: string): boolean {
  return PlanId.safeParse(value).success;
}

/** Load a plan saved under .groot/plans/ by its id. */
export async function loadSavedPlan(root: string, planId: string): Promise<OperationPlan> {
  if (!isPlanId(planId)) {
    throw new GrootV2Error("GROOT_E_USAGE", `"${planId}" is not a plan id (plan_…).`, {
      details: { planId },
    });
  }
  const path = statePaths.plan(root, planId);
  try {
    return await loadPlanFile(path);
  } catch (error) {
    if (error instanceof GrootV2Error && error.id === "GROOT_E_NOT_FOUND") {
      throw new GrootV2Error("GROOT_E_NOT_FOUND", `No saved plan ${planId} in this project.`, {
        hint: "Saved plans live in .groot/plans/; pass a plan file path instead.",
        details: { planId, path },
      });
    }
    throw error;
  }
}
