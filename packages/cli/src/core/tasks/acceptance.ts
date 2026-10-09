/**
 * Acceptance checks for a task, run by GROOT (not the agent) inside the
 * task's worktree — or, at integration, inside the fresh integration
 * worktree. Every outcome becomes stored evidence scoped to the task
 * (`scope.taskId`), tied to the exact revision checked:
 *
 * - dependencies first: a worktree with a Bun lockfile gets
 *   `bun install --frozen-lockfile` (dependencies.ts) so checks resolve the
 *   worktree's own packages; a failed install blocks every check;
 * - command criteria run their argv with runProcess (no shell, timeout,
 *   process-group teardown, redacted output);
 * - verify criteria run a Groot verification profile against the worktree's
 *   v2 groot.json; without one the criterion is `blocked`, never a pass.
 *
 * Before review (`reviewed: false`) the checks execute code nobody has read
 * yet, and there is no OS sandbox: it can use the network and read and write
 * any file the user can, outside the worktree too. What Groot does about it:
 * - commands (the install and command criteria) get a credential-free
 *   environment (runners/env.ts); the build/typecheck scripts a verify
 *   criterion runs do NOT — the verification engine runs them with Groot's
 *   own environment — and their evidence says so;
 * - the caller's `tampering` check (the repository guard, guard.ts) runs
 *   after every check: a change to git refs, hooks, or config stops the
 *   remaining checks;
 * - every piece of evidence states these limits.
 * Integration runs after human approval, with the caller's environment.
 * Everything stored — evidence, logs, failure tails — and every event
 * emitted is redacted with the run's env-derived secrets.
 *
 * Evidence lives in the PROJECT's store (.groot/evidence), not the worktree:
 * worktrees are removed after integration, and verification evidence written
 * inside one is moved out (redacted). Work produced by a simulated runner
 * yields evidence flagged `simulated`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BlueprintV2 } from "../contracts/blueprint.ts";
import { type RevisionInfo, schemaUrl, type VerificationProfile } from "../contracts/common.ts";
import { Evidence, type EvidenceStatus } from "../contracts/evidence.ts";
import type { AcceptanceCriterion, Task } from "../contracts/task.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { revisionInfo } from "../git.ts";
import { newId, nowIso } from "../ids.ts";
import { prettyJson } from "../json.ts";
import { runProcess, type SpawnResult, tail } from "../process.ts";
import { redact, redactValue } from "../redact.ts";
import { credentialFreeEnv, isScrubbed } from "../runners/env.ts";
import { type CoreContext, type EventInput, type EventSink, environmentInfo } from "../runtime.ts";
import { statePaths } from "../state.ts";
import { defaultContracts, registerBuiltInCheckers } from "../verify/checkers.ts";
import { hasChecker, runVerification } from "../verify/engine.ts";
import { storeEvidence } from "../verify/store.ts";
import { formatArgv } from "./argv.ts";
import { dependencyPlan, INSTALL_ARGV, INSTALL_TIMEOUT_MS } from "./dependencies.ts";
import type { AcceptanceRecord } from "./store.ts";

const TAIL_LINES = 40;
/** setTimeout fires at once beyond 2^31-1 ms; older task documents may hold larger timeouts. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const SIMULATED_LIMITATION = "the change under test was produced by a simulated runner";
const UNREVIEWED_LIMITATION =
  "ran before review without an OS sandbox: the agent's code could use the network and read and write any file the user can, outside the worktree too — groot checks only the repository's git refs, hooks, and config for changes";
const CREDENTIAL_FREE_LIMITATION =
  "ran before review with credential-like environment variables removed (recognized by name and URL shape; a credential named otherwise stays)";
const STOPPED_BY_TAMPERING =
  "the repository changed outside the worktree while the checks ran (see the task's reason)";

export interface AcceptanceRun {
  /** Project root — the evidence store. */
  readonly root: string;
  /** The worktree being checked. */
  readonly cwd: string;
  readonly task: Task;
  readonly simulated: boolean;
  /** True at integration (after human approval): checks run with the caller's environment. */
  readonly reviewed: boolean;
  /** Exact values redacted from everything stored (knownSecretsFromEnv of the run's env). */
  readonly secrets: readonly string[];
}

interface Checked {
  readonly run: AcceptanceRun;
  readonly revision: RevisionInfo;
  /** Environment of the commands Groot runs (credential-free before review). */
  readonly env: Record<string, string>;
  /** Install dependencies into the worktree before the checks. */
  readonly install: boolean;
  /** Limitations every piece of evidence of this run carries. */
  readonly limitations: readonly string[];
}

/** A command Groot runs as a check (an acceptance command, or the dependency install). */
interface CommandCheck {
  /** Record criterion; the evidence check is `task.<id>`. */
  readonly id: string;
  readonly title: string;
  /** Project-relative directory to run in. */
  readonly unit: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly tool: string;
  readonly artifact: string;
  /** What a failing command means: a failed check, or checks that cannot run at all. */
  readonly onFailure: "fail" | "blocked";
}

/** Before review: no credentials. After review: the caller's env minus agent-session variables. */
function acceptanceEnv(env: CoreContext["env"], reviewed: boolean): Record<string, string> {
  if (!reviewed) return { ...credentialFreeEnv(env), CI: "1" };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isScrubbed(name)) out[name] = value;
  }
  return { ...out, CI: "1" };
}

async function checkContext(ctx: CoreContext, run: AcceptanceRun): Promise<Checked> {
  const plan = await dependencyPlan(run.cwd, ctx.env);
  return {
    run,
    revision: await revisionInfo(run.cwd),
    env: acceptanceEnv(ctx.env, run.reviewed),
    install: plan.install,
    limitations: [
      ...(run.simulated ? [SIMULATED_LIMITATION] : []),
      ...(run.reviewed ? [] : [UNREVIEWED_LIMITATION]),
      ...plan.limitations,
    ],
  };
}

export function readBlueprint(dir: string): { doc: BlueprintV2 | null; reason: string } {
  const path = join(dir, "groot.json");
  if (!existsSync(path)) {
    return { doc: null, reason: "the project has no groot.json (it is not registered with groot)" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (raw?.version === 1) {
      return { doc: null, reason: "groot.json is a v1 manifest (migrate it with `groot migrate`)" };
    }
    const parsed = BlueprintV2.safeParse(raw);
    return parsed.success
      ? { doc: parsed.data, reason: "" }
      : { doc: null, reason: "groot.json is not a valid v2 blueprint" };
  } catch {
    return { doc: null, reason: "groot.json is not valid JSON" };
  }
}

/** Built-in checkers are registered once per process; tasks may run before any surface did it. */
function ensureCheckers(): void {
  if (!hasChecker("structural.blueprint")) registerBuiltInCheckers();
}

function baseEvidence(
  checked: Checked,
  criterion: { id: string; title: string; unit: string },
  limitations: readonly string[] = checked.limitations,
) {
  return {
    $schema: schemaUrl("evidence"),
    schemaVersion: 1 as const,
    kind: "groot.evidence" as const,
    id: newId("ev"),
    check: `task.${criterion.id}`,
    title: criterion.title,
    scope: {
      capability: null,
      unit: criterion.unit,
      operationId: null,
      taskId: checked.run.task.id,
    },
    revision: checked.revision,
    environment: environmentInfo(),
    details: {},
    limitations: [...limitations],
    simulated: checked.run.simulated,
  };
}

function commandStatus(result: SpawnResult, onFailure: CommandCheck["onFailure"]): EvidenceStatus {
  if (result.aborted) return "skipped";
  return result.exitCode === 0 && !result.timedOut ? "pass" : onFailure;
}

function commandSummary(command: string, result: SpawnResult, timeoutMs: number): string {
  if (result.aborted) return `${command} was cancelled`;
  if (result.timedOut) return `${command} timed out after ${Math.round(timeoutMs / 1000)} s`;
  return result.exitCode === 0
    ? `${command} passed (${result.durationMs} ms)`
    : `${command} exited ${result.exitCode ?? result.signal}`;
}

/** Store a command check's outcome (its redacted log as the artifact); returns the evidence id. */
function storeCommandEvidence(
  checked: Checked,
  check: CommandCheck,
  outcome: { result: SpawnResult; status: EvidenceStatus; summary: string; log: string },
  startedAt: string,
): string {
  const { result } = outcome;
  const limitations = checked.run.reviewed
    ? checked.limitations
    : [...checked.limitations, CREDENTIAL_FREE_LIMITATION];
  const evidence = storeEvidence(
    checked.run.root,
    {
      ...baseEvidence(checked, check, limitations),
      profile: "build",
      status: outcome.status,
      method: {
        kind: "command",
        tool: check.tool,
        command: { argv: [...check.argv], cwd: check.unit, exitCode: result.exitCode },
      },
      startedAt,
      finishedAt: nowIso(),
      durationMs: result.durationMs,
      summary: outcome.summary,
      reason: result.aborted ? "cancelled" : null,
      nextStep: null,
    },
    [{ name: check.artifact, kind: "log", content: outcome.log }],
    checked.run.secrets,
  );
  return evidence.id;
}

async function commandCheck(
  ctx: CoreContext,
  checked: Checked,
  check: CommandCheck,
): Promise<AcceptanceRecord> {
  const { secrets } = checked.run;
  const command = formatArgv(check.argv);
  const startedAt = nowIso();
  const result = await runProcess({
    argv: check.argv,
    cwd: check.unit === "." ? checked.run.cwd : resolveInProject(checked.run.cwd, check.unit),
    env: checked.env,
    timeoutMs: Math.min(check.timeoutMs, MAX_TIMEOUT_MS),
    signal: ctx.signal,
    secrets,
  });
  const log = redact(`$ ${command}\n${result.stdout}\n${result.stderr}`, secrets);
  const status = commandStatus(result, check.onFailure);
  const summary = redact(commandSummary(command, result, check.timeoutMs), secrets);
  const evidence = storeCommandEvidence(
    checked,
    check,
    { result, status, summary, log },
    startedAt,
  );
  return {
    criterion: check.id,
    status,
    evidence: [evidence],
    summary,
    tail: status === "fail" || status === "blocked" ? tail(log, TAIL_LINES) : "",
  };
}

const INSTALL_CHECK: CommandCheck = {
  id: "dependencies",
  title: "install the worktree's dependencies",
  unit: ".",
  argv: INSTALL_ARGV,
  timeoutMs: INSTALL_TIMEOUT_MS,
  tool: "task.dependencies",
  artifact: "install.log",
  onFailure: "blocked",
};

function criterionCheck(criterion: AcceptanceCriterion): CommandCheck {
  return {
    id: criterion.id,
    title: criterion.description,
    unit: criterion.cwd,
    argv: criterion.argv ?? [],
    timeoutMs: criterion.timeoutMs,
    tool: "task.acceptance",
    artifact: "output.log",
    onFailure: "fail",
  };
}

/** Where an artifact recorded in the worktree's store lives, relative to its evidence directory. */
function artifactName(worktree: string, record: Evidence, path: string): string | null {
  const name = relative(statePaths.evidence(worktree, record.id), join(worktree, path));
  return name === "" || name.startsWith("..") ? null : name;
}

/**
 * Move evidence produced inside a worktree into the project's store (same
 * id), redacted with the run's secrets and carrying the run's limitations;
 * nothing is left in the worktree, where a later attempt's agent could read it.
 */
function importEvidence(checked: Checked, record: Evidence): Evidence {
  const { run } = checked;
  const from = statePaths.evidence(run.cwd, record.id);
  const to = statePaths.evidence(run.root, record.id);
  const artifacts = record.artifacts.flatMap((artifact) => {
    const name = artifactName(run.cwd, record, artifact.path);
    if (name === null || !existsSync(join(from, name))) return [];
    const content = redact(readFileSync(join(from, name), "utf8"), run.secrets);
    mkdirSync(dirname(join(to, name)), { recursive: true });
    writeFileAtomic(join(to, name), content);
    return [{ ...artifact, sha256: sha256Of(content), bytes: Buffer.byteLength(content) }];
  });
  const imported = Evidence.parse({
    ...redactValue(record, run.secrets),
    artifacts,
    simulated: record.simulated || run.simulated,
    limitations: [...new Set([...record.limitations, ...checked.limitations])],
  });
  mkdirSync(to, { recursive: true });
  writeFileAtomic(join(to, "evidence.json"), prettyJson(imported));
  rmSync(from, { recursive: true, force: true });
  return imported;
}

function aggregate(statuses: readonly EvidenceStatus[]): EvidenceStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("blocked")) return "blocked";
  return statuses.includes("pass") ? "pass" : "skipped";
}

export interface ProfileRun {
  readonly status: EvidenceStatus;
  readonly evidence: string[];
  readonly summary: string;
  readonly failures: string;
  /** False when the worktree has no v2 groot.json (nothing to verify against). */
  readonly registered: boolean;
}

function unregisteredRun(
  checked: Checked,
  profiles: readonly VerificationProfile[],
  checkId: string,
  status: "blocked" | "skipped",
  reason: string,
): ProfileRun {
  const now = nowIso();
  const evidence = storeEvidence(
    checked.run.root,
    {
      ...baseEvidence(checked, {
        id: checkId,
        title: `verification (${profiles.join(", ")})`,
        unit: ".",
      }),
      profile: profiles[0] ?? "structural",
      status,
      method: { kind: "static", tool: "task.verify", command: null },
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      summary: `not verified: ${reason}`,
      reason,
      nextStep:
        "Register the project with a v2 groot.json (groot adopt / groot migrate) to verify structure and builds.",
    },
    [],
    checked.run.secrets,
  );
  return {
    status,
    evidence: [evidence.id],
    summary: evidence.summary,
    failures: "",
    registered: false,
  };
}

/**
 * Events the verification engine emits carry its checks' output tails
 * (`check.finished`); the CLI prints them and MCP forwards them, so they are
 * redacted with the run's env-derived secrets like everything stored.
 */
function redactingEvents(events: EventSink, secrets: readonly string[]): EventSink {
  return {
    emit(event: EventInput): void {
      events.emit({
        ...event,
        message: redact(event.message, secrets),
        ...(event.data === undefined ? {} : { data: redactValue(event.data, secrets) }),
      });
    },
  };
}

async function verifyChecked(
  ctx: CoreContext,
  checked: Checked,
  profiles: readonly VerificationProfile[],
  checkId: string,
  unregistered: "blocked" | "skipped",
): Promise<ProfileRun> {
  const { run } = checked;
  const blueprint = readBlueprint(run.cwd);
  if (blueprint.doc === null) {
    return unregisteredRun(checked, profiles, checkId, unregistered, blueprint.reason);
  }
  ensureCheckers();
  const report = await runVerification(
    { ...ctx, env: checked.env, events: redactingEvents(ctx.events, run.secrets) },
    {
      root: run.cwd,
      blueprint: blueprint.doc,
      observation: null,
      lock: null,
      profiles,
      taskId: run.task.id,
      extra: defaultContracts(blueprint.doc),
    },
  );
  const evidence = report.evidence.map((record) => importEvidence(checked, record));
  const count = (status: EvidenceStatus) =>
    evidence.filter((record) => record.status === status).length;
  return {
    status: aggregate(evidence.map((record) => record.status)),
    evidence: evidence.map((record) => record.id),
    summary: `${profiles.join("+")}: ${count("pass")} pass, ${count("fail")} fail, ${count("blocked")} blocked, ${count("skipped")} skipped`,
    failures: evidence
      .filter((record) => record.status === "fail" || record.status === "blocked")
      .map((record) => `${record.check}: ${record.summary}`)
      .join("\n"),
    registered: true,
  };
}

/**
 * Run verification profiles against a worktree; evidence is moved into the
 * project store. Without a v2 groot.json there is nothing to verify against:
 * that is `blocked` for an explicit verify criterion, `skipped` (reported,
 * not gating) for the extra profiles integration runs.
 */
export async function verifyWorktree(
  ctx: CoreContext,
  run: AcceptanceRun,
  profiles: readonly VerificationProfile[],
  checkId: string,
  unregistered: "blocked" | "skipped" = "blocked",
): Promise<ProfileRun> {
  return verifyChecked(ctx, await checkContext(ctx, run), profiles, checkId, unregistered);
}

async function runCriterion(
  ctx: CoreContext,
  checked: Checked,
  criterion: AcceptanceCriterion,
): Promise<AcceptanceRecord> {
  if (criterion.kind === "command") return commandCheck(ctx, checked, criterionCheck(criterion));
  const profile = [criterion.profile ?? "structural"];
  const outcome = await verifyChecked(ctx, checked, profile, criterion.id, "blocked");
  return {
    criterion: criterion.id,
    status: outcome.status,
    evidence: outcome.evidence,
    summary: outcome.summary,
    tail: outcome.failures,
  };
}

function notRun(id: string, why: string): AcceptanceRecord {
  return { criterion: id, status: "skipped", evidence: [], summary: `not run — ${why}`, tail: "" };
}

function emitRecord(ctx: CoreContext, task: Task, title: string, record: AcceptanceRecord): void {
  ctx.events.emit({
    type: "task.acceptance",
    level: record.status === "pass" ? "info" : record.status === "fail" ? "error" : "warn",
    message: `${record.status.toUpperCase()} ${title} — ${record.summary}`,
    taskId: task.id,
    data: { criterion: record.criterion, evidence: record.evidence, status: record.status },
  });
}

export interface AcceptanceOptions {
  /** "always": install even without criteria (integration — its verification needs them). */
  readonly install?: "with-criteria" | "always";
  /**
   * Asked after every check: what changed in the repository that must not
   * have (the repository guard). A non-empty answer stops the remaining checks.
   */
  readonly tampering?: () => Promise<readonly string[]>;
}

export interface AcceptanceOutcome {
  readonly records: AcceptanceRecord[];
  /** What stopped the checks (empty: none stopped them). */
  readonly tampering: readonly string[];
}

/** Why the next criterion does not run (null: it runs). */
function skipReason(
  ctx: CoreContext,
  installed: boolean,
  tampering: readonly string[],
): string | null {
  if (ctx.signal.aborted) return "cancelled";
  if (tampering.length > 0) return STOPPED_BY_TAMPERING;
  return installed ? null : "the worktree's dependencies could not be installed";
}

const NOTHING_CHANGED = async (): Promise<readonly string[]> => [];

/**
 * Install the worktree's dependencies, then run every acceptance criterion
 * in `run.cwd`, asking `options.tampering` after each. A task without
 * criteria runs nothing — unless `options.install` is "always".
 */
export async function runAcceptance(
  ctx: CoreContext,
  run: AcceptanceRun,
  options: AcceptanceOptions = {},
): Promise<AcceptanceOutcome> {
  if (run.task.acceptance.length === 0 && options.install !== "always") {
    return { records: [], tampering: [] };
  }
  const checked = await checkContext(ctx, run);
  const changed = options.tampering ?? NOTHING_CHANGED;
  const records: AcceptanceRecord[] = [];
  let tampering: readonly string[] = [];
  if (checked.install && !ctx.signal.aborted) {
    const install = await commandCheck(ctx, checked, INSTALL_CHECK);
    records.push(install);
    emitRecord(ctx, run.task, INSTALL_CHECK.title, install);
    tampering = await changed();
  }
  const installed = records.every((record) => record.status === "pass");
  for (const criterion of run.task.acceptance) {
    const skip = skipReason(ctx, installed, tampering);
    const record =
      skip === null ? await runCriterion(ctx, checked, criterion) : notRun(criterion.id, skip);
    records.push(record);
    emitRecord(ctx, run.task, criterion.description, record);
    if (skip === null) tampering = await changed();
  }
  return { records, tampering };
}
