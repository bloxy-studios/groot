/**
 * Acceptance checks for a task, run by GROOT (not the agent) inside the
 * task's worktree — or, at integration, inside the fresh integration
 * worktree. Every outcome becomes stored evidence scoped to the task
 * (`scope.taskId`), tied to the exact revision checked:
 *
 * - command criteria run their argv with runProcess (no shell, timeout,
 *   process-group teardown, redacted output);
 * - verify criteria run a Groot verification profile against the worktree's
 *   v2 groot.json; without one the criterion is `blocked`, never a pass.
 *
 * Evidence lives in the PROJECT's store (.groot/evidence), not the worktree:
 * worktrees are removed after integration. Work produced by a simulated
 * runner yields evidence flagged `simulated`.
 */
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintV2 } from "../contracts/blueprint.ts";
import { type RevisionInfo, schemaUrl, type VerificationProfile } from "../contracts/common.ts";
import { Evidence, type EvidenceStatus } from "../contracts/evidence.ts";
import type { AcceptanceCriterion, Task } from "../contracts/task.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { resolveInProject } from "../fs/paths.ts";
import { revisionInfo } from "../git.ts";
import { newId, nowIso } from "../ids.ts";
import { prettyJson } from "../json.ts";
import { runProcess, tail } from "../process.ts";
import { redact } from "../redact.ts";
import { isScrubbed } from "../runners/env.ts";
import { type CoreContext, environmentInfo } from "../runtime.ts";
import { statePaths } from "../state.ts";
import { defaultContracts, registerBuiltInCheckers } from "../verify/checkers.ts";
import { hasChecker, runVerification } from "../verify/engine.ts";
import { storeEvidence } from "../verify/store.ts";
import { formatArgv } from "./argv.ts";
import type { AcceptanceRecord } from "./store.ts";

const TAIL_LINES = 40;
const SIMULATED_LIMITATION = "the change under test was produced by a simulated runner";

export interface AcceptanceRun {
  /** Project root — the evidence store. */
  readonly root: string;
  /** The worktree being checked. */
  readonly cwd: string;
  readonly task: Task;
  readonly simulated: boolean;
}

interface Checked {
  readonly run: AcceptanceRun;
  readonly revision: RevisionInfo;
}

/** Environment for project commands: the caller's, minus agent-session variables, CI=1. */
function acceptanceEnv(env: CoreContext["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isScrubbed(name)) out[name] = value;
  }
  return { ...out, CI: "1" };
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

function baseEvidence(checked: Checked, criterion: { id: string; title: string; unit: string }) {
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
    limitations: checked.run.simulated ? [SIMULATED_LIMITATION] : [],
    simulated: checked.run.simulated,
  };
}

async function commandCriterion(
  ctx: CoreContext,
  checked: Checked,
  criterion: AcceptanceCriterion,
): Promise<AcceptanceRecord> {
  const argv = criterion.argv ?? [];
  const command = formatArgv(argv);
  const startedAt = nowIso();
  const cwd =
    criterion.cwd === "." ? checked.run.cwd : resolveInProject(checked.run.cwd, criterion.cwd);
  const result = await runProcess({
    argv,
    cwd,
    env: acceptanceEnv(ctx.env),
    timeoutMs: criterion.timeoutMs,
    signal: ctx.signal,
  });
  const log = redact(`$ ${command}\n${result.stdout}\n${result.stderr}`);
  const status: EvidenceStatus = result.aborted
    ? "skipped"
    : result.exitCode === 0 && !result.timedOut
      ? "pass"
      : "fail";
  const summary = result.aborted
    ? `${command} was cancelled`
    : result.timedOut
      ? `${command} timed out after ${Math.round(criterion.timeoutMs / 1000)} s`
      : status === "pass"
        ? `${command} passed (${result.durationMs} ms)`
        : `${command} exited ${result.exitCode ?? result.signal}`;
  const evidence = storeEvidence(
    checked.run.root,
    {
      ...baseEvidence(checked, {
        id: criterion.id,
        title: criterion.description,
        unit: criterion.cwd,
      }),
      profile: "build",
      status,
      method: {
        kind: "command",
        tool: "task.acceptance",
        command: { argv, cwd: criterion.cwd, exitCode: result.exitCode },
      },
      startedAt,
      finishedAt: nowIso(),
      durationMs: result.durationMs,
      summary,
      reason: result.aborted ? "cancelled" : null,
      nextStep: null,
    },
    [{ name: "output.log", kind: "log", content: log }],
  );
  return {
    criterion: criterion.id,
    status,
    evidence: [evidence.id],
    summary,
    tail: status === "fail" ? tail(log, TAIL_LINES) : "",
  };
}

/** Copy evidence produced inside a worktree into the project's store (same id). */
function importEvidence(
  root: string,
  worktree: string,
  record: Evidence,
  simulated: boolean,
): string {
  const from = statePaths.evidence(worktree, record.id);
  const to = statePaths.evidence(root, record.id);
  cpSync(from, to, { recursive: true });
  if (simulated && !record.simulated) {
    const flagged = Evidence.parse({
      ...record,
      simulated: true,
      limitations: [...record.limitations, SIMULATED_LIMITATION],
    });
    writeFileAtomic(join(to, "evidence.json"), prettyJson(flagged));
  }
  return record.id;
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
}

/**
 * Run verification profiles against a worktree; evidence is imported into the
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
  const blueprint = readBlueprint(run.cwd);
  const checked: Checked = { run, revision: await revisionInfo(run.cwd) };
  if (blueprint.doc === null) {
    const now = nowIso();
    const evidence = storeEvidence(
      run.root,
      {
        ...baseEvidence(checked, {
          id: checkId,
          title: `verification (${profiles.join(", ")})`,
          unit: ".",
        }),
        profile: profiles[0] ?? "structural",
        status: unregistered,
        method: { kind: "static", tool: "task.verify", command: null },
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        summary: `not verified: ${blueprint.reason}`,
        reason: blueprint.reason,
        nextStep:
          "Register the project with a v2 groot.json (groot adopt / groot migrate) to verify structure and builds.",
      },
      [],
    );
    return {
      status: unregistered,
      evidence: [evidence.id],
      summary: evidence.summary,
      failures: "",
    };
  }
  ensureCheckers();
  const report = await runVerification(ctx, {
    root: run.cwd,
    blueprint: blueprint.doc,
    observation: null,
    lock: null,
    profiles,
    taskId: run.task.id,
    extra: defaultContracts(blueprint.doc),
  });
  const ids = report.evidence.map((record) =>
    importEvidence(run.root, run.cwd, record, run.simulated),
  );
  const count = (status: EvidenceStatus) =>
    report.evidence.filter((record) => record.status === status).length;
  return {
    status: aggregate(report.evidence.map((record) => record.status)),
    evidence: ids,
    summary: `${profiles.join("+")}: ${count("pass")} pass, ${count("fail")} fail, ${count("blocked")} blocked, ${count("skipped")} skipped`,
    failures: report.evidence
      .filter((record) => record.status === "fail" || record.status === "blocked")
      .map((record) => `${record.check}: ${record.summary}`)
      .join("\n"),
  };
}

async function verifyCriterion(
  ctx: CoreContext,
  run: AcceptanceRun,
  criterion: AcceptanceCriterion,
): Promise<AcceptanceRecord> {
  const outcome = await verifyWorktree(ctx, run, [criterion.profile ?? "structural"], criterion.id);
  return {
    criterion: criterion.id,
    status: outcome.status,
    evidence: outcome.evidence,
    summary: outcome.summary,
    tail: outcome.failures,
  };
}

/** Run every acceptance criterion of a task in `run.cwd`. */
export async function runAcceptance(
  ctx: CoreContext,
  run: AcceptanceRun,
): Promise<AcceptanceRecord[]> {
  const checked: Checked = { run, revision: await revisionInfo(run.cwd) };
  const records: AcceptanceRecord[] = [];
  for (const criterion of run.task.acceptance) {
    if (ctx.signal.aborted) {
      records.push({
        criterion: criterion.id,
        status: "skipped",
        evidence: [],
        summary: "not run — cancelled",
        tail: "",
      });
      continue;
    }
    const record =
      criterion.kind === "command"
        ? await commandCriterion(ctx, checked, criterion)
        : await verifyCriterion(ctx, run, criterion);
    records.push(record);
    ctx.events.emit({
      type: "task.acceptance",
      level: record.status === "pass" ? "info" : record.status === "fail" ? "error" : "warn",
      message: `${record.status.toUpperCase()} ${criterion.description} — ${record.summary}`,
      taskId: run.task.id,
      data: { criterion: criterion.id, evidence: record.evidence, status: record.status },
    });
  }
  return records;
}
