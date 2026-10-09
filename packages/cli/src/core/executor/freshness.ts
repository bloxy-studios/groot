/**
 * Plan freshness: is the project still in the state the plan was computed
 * against? Only the plan's own preconditions matter — a path it touches, the
 * manifest state, a toolchain, a directory that must be fresh — so unrelated
 * edits never make a plan stale, and a stale plan names exactly the affected
 * paths (docs/v2-architecture.md#execution).
 *
 * The same expectation check runs again right before each step (apply and
 * resume), because humans don't take Groot's lock: an edit made while an
 * operation runs — or while it sits interrupted — is caught at the step that
 * would have overwritten it. A `produced` expectation passes only against the
 * result its producer journaled (a file hash, or `tree:<dir>` for generated
 * directories) — a missing result is a finding.
 *
 * Checking is read-only apart from toolchain version probes, and those run
 * only allowlisted tools found on PATH outside the project; a plan cannot
 * make the check execute a path or name of its choosing.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, relative } from "node:path";
import type { Sha256 } from "../contracts/common.ts";
import type { OperationPlan, PathExpectation, Precondition } from "../contracts/plan.ts";
import { PROBES } from "../discovery/toolchains.ts";
import { GrootV2Error } from "../errors.ts";
import { hashFile } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { canonicalJson } from "../json.ts";
import { runProcess } from "../process.ts";
import { STATE_DIR_NAME } from "../state.ts";
import { isWithin, ownExpectation, packageJsonPath } from "./action-paths.ts";
import { currentHash, pathKind } from "./fsops.ts";
import type { StaleFinding } from "./types.ts";

/** Wall-time cap for `<tool> --version` probes. */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** What a completed step journaled for a path: its file key, or `tree:<path>` for a directory. */
export interface ProducedResult {
  readonly key: string;
  readonly hash: Sha256 | null;
}

/** Looks up a completed earlier step's recorded result for a path (undefined = none recorded). */
export type ProducedHash = (byStep: string, path: string) => ProducedResult | undefined;

const describe = (hash: Sha256 | null): string => hash ?? "absent";

async function checkPath(
  root: string,
  path: string,
  expect: PathExpectation,
  produced: ProducedHash,
): Promise<StaleFinding | null> {
  if (expect.state === "produced") {
    // No recorded result means nothing vouches for the path: never a pass.
    const recorded = produced(expect.byStep, path);
    if (recorded === undefined) {
      return {
        path,
        expected: `the result of step ${expect.byStep}`,
        actual: "no result recorded",
        reason: `step ${expect.byStep} has not recorded a result for it`,
      };
    }
    const actual = await currentHash(root, recorded.key);
    if (actual === recorded.hash) return null;
    return {
      path,
      expected: describe(recorded.hash),
      actual: describe(actual),
      reason: `changed after step ${expect.byStep} produced it`,
    };
  }
  const kind = pathKind(resolveInProject(root, path));
  if (expect.state === "absent") {
    if (kind === "absent") return null;
    const actual = kind === "file" ? describe(await currentHash(root, path)) : `a ${kind}`;
    return { path, expected: "absent", actual, reason: "was created after the plan was made" };
  }
  if (kind === "file" && (await currentHash(root, path)) === expect.sha256) return null;
  if (kind === "absent") {
    return {
      path,
      expected: expect.sha256,
      actual: "absent",
      reason: "was deleted after the plan was made",
    };
  }
  return {
    path,
    expected: expect.sha256,
    actual: kind === "file" ? describe(await currentHash(root, path)) : `a ${kind}`,
    reason: "changed after the plan was made",
  };
}

async function checkManifest(
  root: string,
  pre: Extract<Precondition, { type: "manifest" }>,
): Promise<StaleFinding | null> {
  const abs = resolveInProject(root, "groot.json");
  const hash = await hashFile(abs);
  const expected = pre.state === "absent" ? "absent" : `groot.json v${pre.state.slice(1)}`;
  if (pre.state === "absent") {
    return hash === null
      ? null
      : {
          path: "groot.json",
          expected,
          actual: hash,
          reason: "a manifest appeared after planning",
        };
  }
  if (hash === null) {
    return { path: "groot.json", expected, actual: "absent", reason: "the manifest was removed" };
  }
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(abs, "utf8")) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  if (`v${String(version)}` !== pre.state) {
    return {
      path: "groot.json",
      expected,
      actual: `groot.json version ${String(version)}`,
      reason: "the manifest version changed after planning",
    };
  }
  if (pre.sha256 !== null && pre.sha256 !== hash) {
    return {
      path: "groot.json",
      expected: pre.sha256,
      actual: hash,
      reason: "changed after the plan was made",
    };
  }
  return null;
}

function parseVersion(text: string): number[] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** a >= b over [major, minor, patch]. */
function atLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** PATH with only absolute entries — a relative entry would resolve against the cwd. */
function absolutePath(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

function insideProject(root: string, executable: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(executable));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return true; // cannot tell where it really is: never run it
  }
}

/**
 * The version banner of a toolchain, or why it was not probed. A plan names
 * the tool, so only the vetted probes discovery uses (core/discovery/
 * toolchains.ts) run: bun is the running runtime, anything else is found on
 * PATH — never inside the project — and asked for its version from a neutral
 * directory. Paths and unknown names are reported, never executed.
 */
async function toolVersion(
  root: string,
  id: string,
): Promise<{ output: string } | { why: string }> {
  if (id === "bun") return { output: Bun.version };
  const probe = Object.hasOwn(PROBES, id) ? PROBES[id] : undefined;
  if (probe === undefined) return { why: "not a toolchain groot can probe (it was not run)" };
  const [name, ...args] = probe.argv;
  if (probe.darwinOnly === true && process.platform !== "darwin") {
    return { why: `${name} exists only on macOS` };
  }
  const executable = name === undefined ? null : Bun.which(name, { PATH: absolutePath() });
  if (executable === null) return { why: "not found on PATH" };
  if (insideProject(root, executable)) {
    return { why: `${executable} is inside the project (it was not run)` };
  }
  const result = await runProcess({
    argv: [executable, ...args],
    cwd: tmpdir(),
    env: { ...process.env, GOTOOLCHAIN: "local" },
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  return { output: `${result.stdout}\n${result.stderr}`.trim() };
}

async function checkToolchain(
  root: string,
  pre: Extract<Precondition, { type: "toolchain" }>,
): Promise<StaleFinding | null> {
  const path = `toolchain:${pre.id}`;
  const expected =
    pre.minVersion === null ? `${pre.id} installed` : `${pre.id} >= ${pre.minVersion}`;
  const probed = await toolVersion(root, pre.id);
  if ("why" in probed) return { path, expected, actual: probed.why, reason: pre.reason };
  const { output } = probed;
  if (pre.minVersion === null) return null;
  const minimum = parseVersion(pre.minVersion);
  const actual = parseVersion(output);
  if (minimum === null) return null;
  if (actual !== null && atLeast(actual, minimum)) return null;
  return {
    path,
    expected,
    actual: actual === null ? `unknown version (${output.split("\n")[0] ?? ""})` : actual.join("."),
    reason: pre.reason,
  };
}

/** Absent or empty (Groot's own `.groot/` state directory doesn't count). */
export function checkFreshDir(root: string, path: string): StaleFinding | null {
  const abs = resolveInProject(root, path);
  const kind = pathKind(abs);
  if (kind === "absent") return null;
  const expected = "absent or an empty directory";
  if (kind !== "dir") {
    return { path, expected, actual: `a ${kind}`, reason: "the target is in the way" };
  }
  const entries = readdirSync(abs).filter((entry) => entry !== STATE_DIR_NAME);
  if (entries.length === 0) return null;
  return {
    path,
    expected,
    actual: `a directory with ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    reason: "the target directory is no longer empty",
  };
}

async function checkPrecondition(
  root: string,
  pre: Precondition,
  produced: ProducedHash,
): Promise<StaleFinding | null> {
  switch (pre.type) {
    case "path":
      return checkPath(root, pre.path, pre.expect, produced);
    case "manifest":
      return checkManifest(root, pre);
    case "toolchain":
      return checkToolchain(root, pre);
    case "fresh-dir":
      return checkFreshDir(root, pre.path);
  }
}

const NOTHING_PRODUCED: ProducedHash = () => undefined;

/** Identity of a precondition; path checks include the expectation, so a disagreeing one is kept. */
function preconditionKey(pre: Precondition): string {
  if (pre.type === "path") return `path:${pre.path}:${canonicalJson(pre.expect)}`;
  if (pre.type === "fresh-dir") return `fresh:${pre.path}`;
  return pre.type === "toolchain" ? `toolchain:${pre.id}` : "manifest";
}

function touchedPaths(action: OperationPlan["actions"][number]): string[] {
  switch (action.type) {
    case "file.move":
      return [action.from, action.to];
    case "generator.run":
      return [action.produces];
    case "deps.add":
      return [packageJsonPath(action.unit)];
    case "command.run":
    case "internal":
      return action.touches;
    case "external":
      return [];
    default:
      return [action.path];
  }
}

/**
 * Preconditions the actions imply but a plan may not record: each step's own
 * expectation of a path no earlier step changes, a generator's destination
 * fresh, a move's target absent. Checking them with the declared ones keeps
 * "a stale plan writes nothing" true even for a plan whose preconditions
 * under-declare (or contradict) its actions, instead of failing halfway.
 */
export function impliedPreconditions(plan: OperationPlan): Precondition[] {
  const known = new Set(plan.preconditions.map(preconditionKey));
  const touched: string[] = [];
  const implied: Precondition[] = [];
  const add = (pre: Precondition): void => {
    if (known.has(preconditionKey(pre))) return;
    known.add(preconditionKey(pre));
    implied.push(pre);
  };
  // An earlier step changed the path itself, or a tree containing it.
  const changedEarlier = (path: string): boolean => touched.some((p) => isWithin(path, p));
  const touchedUnder = (dir: string): boolean => touched.some((p) => isWithin(p, dir));
  for (const action of plan.actions) {
    const own = ownExpectation(action);
    if (own !== null && own.expect.state !== "produced" && !changedEarlier(own.path)) {
      add({ type: "path", path: own.path, expect: own.expect, dirty: false });
    }
    if (action.type === "generator.run" && !touchedUnder(action.produces)) {
      add({ type: "fresh-dir", path: action.produces });
    }
    if (action.type === "file.move" && !changedEarlier(action.to)) {
      add({ type: "path", path: action.to, expect: { state: "absent" }, dirty: false });
    }
    touched.push(...touchedPaths(action));
  }
  return implied;
}

/** Evaluate every plan precondition; an empty list means the plan is fresh. */
export async function checkPreconditions(
  root: string,
  preconditions: readonly Precondition[],
  produced: ProducedHash = NOTHING_PRODUCED,
): Promise<StaleFinding[]> {
  const findings: StaleFinding[] = [];
  for (const pre of preconditions) {
    const finding = await checkPrecondition(root, pre, produced);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/** Re-check one path expectation (used per step right before its effect). */
export function checkExpectation(
  root: string,
  path: string,
  expect: PathExpectation,
  produced: ProducedHash,
): Promise<StaleFinding | null> {
  return checkPath(root, path, expect, produced);
}

/** GROOT_E_STALE_PLAN naming exactly the affected paths; nothing was written. */
export function staleError(
  findings: readonly StaleFinding[],
  options: { planId: string; operationId?: string; stepId?: string },
): GrootV2Error {
  const paths = findings.map((finding) => finding.path);
  const where = options.stepId === undefined ? "" : ` before step ${options.stepId}`;
  return new GrootV2Error(
    "GROOT_E_STALE_PLAN",
    `The plan is stale${where}: ${paths.join(", ")} changed since it was made.`,
    {
      hint:
        options.operationId === undefined
          ? "Nothing was changed. Re-create the plan against the current files, or restore those paths."
          : `Completed steps are kept. Restore those paths and run \`groot resume ${options.operationId}\`, or re-plan.`,
      details: {
        findings,
        planId: options.planId,
        operationId: options.operationId ?? null,
        stepId: options.stepId ?? null,
      },
    },
  );
}
