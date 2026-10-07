/**
 * Verification engine: runs the declared verification contracts for the
 * requested profiles, turns every outcome into stored evidence tied to the
 * revision and environment actually checked, and summarizes each profile
 * separately. Missing checkers, toolchains, or credentials become `blocked`
 * evidence with the exact prerequisite — never a silent pass.
 */
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import type {
  RevisionInfo,
  VerificationContract,
  VerificationProfile,
} from "../contracts/common.ts";
import { schemaUrl } from "../contracts/common.ts";
import type {
  Evidence,
  EvidenceStatus,
  ProfileSummary,
  VerificationReport,
} from "../contracts/evidence.ts";
import type { GrootLock } from "../contracts/lock.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { revisionInfo } from "../git.ts";
import { newId, nowIso } from "../ids.ts";
import { type CoreContext, environmentInfo } from "../runtime.ts";
import type { ArtifactInput } from "./store.ts";
import { storeEvidence } from "./store.ts";

export interface CheckInput {
  readonly ctx: CoreContext;
  readonly root: string;
  readonly contract: VerificationContract;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation | null;
  readonly lock: GrootLock | null;
}

export interface CheckOutcome {
  readonly status: EvidenceStatus;
  readonly summary: string;
  readonly method: Evidence["method"];
  readonly details?: Record<string, unknown>;
  readonly artifacts?: readonly ArtifactInput[];
  readonly limitations?: readonly string[];
  readonly reason?: string | null;
  readonly nextStep?: string | null;
  /** Values generated for the check (e.g. a throwaway auth secret) — redacted from artifacts. */
  readonly secrets?: readonly string[];
  readonly simulated?: boolean;
}

export type Checker = (input: CheckInput) => Promise<CheckOutcome>;

const checkers = new Map<string, Checker>();

export function registerChecker(id: string, checker: Checker): void {
  checkers.set(id, checker);
}

export function hasChecker(id: string): boolean {
  return checkers.has(id);
}

export interface VerifyRequest {
  readonly root: string;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation | null;
  readonly lock: GrootLock | null;
  readonly profiles: readonly VerificationProfile[];
  readonly capability?: string | null;
  readonly unit?: string | null;
  readonly operationId?: string | null;
  readonly taskId?: string | null;
  /** Contracts beyond the blueprint's own (defaults computed by the caller). */
  readonly extra?: readonly VerificationContract[];
}

const PROFILES: readonly VerificationProfile[] = ["structural", "build", "runtime", "product-flow"];

/** Contracts to run for a request, deduplicated by id, in profile order. */
export function selectContracts(request: VerifyRequest): VerificationContract[] {
  const byId = new Map<string, VerificationContract>();
  for (const contract of [...request.blueprint.verification, ...(request.extra ?? [])]) {
    if (!byId.has(contract.id)) byId.set(contract.id, contract);
  }
  return [...byId.values()]
    .filter((contract) => request.profiles.includes(contract.profile))
    .filter(
      (contract) =>
        request.capability == null ||
        contract.capability === request.capability ||
        (contract.capability === null && contract.profile === "structural"),
    )
    .filter(
      (contract) =>
        request.unit == null || contract.unit === null || contract.unit === request.unit,
    )
    .sort((a, b) => PROFILES.indexOf(a.profile) - PROFILES.indexOf(b.profile));
}

function missingToolchains(contract: VerificationContract): string[] {
  return contract.needs.toolchains.filter((tool) => Bun.which(tool) === null);
}

async function runOne(
  ctx: CoreContext,
  request: VerifyRequest,
  contract: VerificationContract,
): Promise<CheckOutcome> {
  if (ctx.signal.aborted) {
    return {
      status: "skipped",
      summary: "not run — verification was cancelled",
      method: { kind: "static", tool: "groot.verify", command: null },
      reason: "cancelled",
    };
  }
  const checker = checkers.get(contract.checker);
  if (checker === undefined) {
    return {
      status: "blocked",
      summary: `no checker "${contract.checker}" in this Groot version`,
      method: { kind: "static", tool: "groot.verify", command: null },
      reason: `checker ${contract.checker} is not registered`,
      nextStep: "Upgrade groot, or remove the stale verification contract from groot.json.",
    };
  }
  const missing = missingToolchains(contract);
  if (missing.length > 0) {
    return {
      status: "blocked",
      summary: `requires ${missing.join(", ")} which ${missing.length === 1 ? "is" : "are"} not installed`,
      method: { kind: "static", tool: "groot.verify", command: null },
      reason: `missing toolchain: ${missing.join(", ")}`,
      nextStep: `Install ${missing.join(", ")} and re-run groot verify.`,
    };
  }
  try {
    return await checker({
      ctx,
      root: request.root,
      contract,
      blueprint: request.blueprint,
      observation: request.observation,
      lock: request.lock,
    });
  } catch (error) {
    return {
      status: "fail",
      summary: `checker crashed: ${error instanceof Error ? error.message : String(error)}`,
      method: { kind: "static", tool: contract.checker, command: null },
      reason: "internal checker error",
    };
  }
}

function summarize(evidence: readonly Evidence[], requested: boolean): ProfileSummary {
  const count = (status: EvidenceStatus): number =>
    evidence.filter((entry) => entry.status === status).length;
  const summary = {
    pass: count("pass"),
    fail: count("fail"),
    skipped: count("skipped"),
    blocked: count("blocked"),
  };
  let status: ProfileSummary["status"] = "not-run";
  if (requested && evidence.length > 0) {
    if (summary.fail > 0) status = "fail";
    else if (summary.blocked > 0) status = "blocked";
    else if (summary.pass > 0) status = "pass";
    else status = "skipped";
  }
  return { status, ...summary };
}

export async function runVerification(
  ctx: CoreContext,
  request: VerifyRequest,
): Promise<VerificationReport> {
  const startedAt = nowIso();
  const revision: RevisionInfo = await revisionInfo(request.root);
  const environment = environmentInfo(ctx.env);
  const evidence: Evidence[] = [];

  for (const contract of selectContracts(request)) {
    ctx.events.emit({
      type: "check.started",
      level: "info",
      message: `${contract.profile}: ${contract.description}`,
      data: { check: contract.id },
    });
    const started = performance.now();
    const checkStartedAt = nowIso();
    const outcome = await runOne(ctx, request, contract);
    const record = storeEvidence(
      request.root,
      {
        $schema: schemaUrl("evidence"),
        schemaVersion: 1,
        kind: "groot.evidence",
        id: newId("ev"),
        check: contract.id,
        title: contract.description,
        profile: contract.profile,
        status: outcome.status,
        scope: {
          capability: contract.capability,
          unit: contract.unit,
          operationId: request.operationId ?? null,
          taskId: request.taskId ?? null,
        },
        method: outcome.method,
        revision,
        environment,
        startedAt: checkStartedAt,
        finishedAt: nowIso(),
        durationMs: Math.round(performance.now() - started),
        summary: outcome.summary,
        details: outcome.details ?? {},
        limitations: [...(outcome.limitations ?? [])],
        reason: outcome.reason ?? null,
        nextStep: outcome.nextStep ?? null,
        simulated: outcome.simulated ?? false,
      },
      outcome.artifacts ?? [],
      outcome.secrets ?? [],
    );
    evidence.push(record);
    ctx.events.emit({
      type: "check.finished",
      level: record.status === "fail" ? "error" : record.status === "pass" ? "info" : "warn",
      message: `${record.status.toUpperCase()} ${contract.id} — ${record.summary}`,
      data: { check: contract.id, evidence: record.id, status: record.status },
    });
  }

  const profileSummary = (profile: VerificationProfile): ProfileSummary =>
    summarize(
      evidence.filter((entry) => entry.profile === profile),
      request.profiles.includes(profile),
    );
  return {
    $schema: schemaUrl("verification"),
    schemaVersion: 1,
    kind: "groot.verification",
    root: request.root,
    revision,
    environment,
    startedAt,
    finishedAt: nowIso(),
    scope: { capability: request.capability ?? null, profiles: [...request.profiles] },
    profiles: {
      structural: profileSummary("structural"),
      build: profileSummary("build"),
      runtime: profileSummary("runtime"),
      "product-flow": profileSummary("product-flow"),
    },
    evidence,
    ok: evidence.every((entry) => entry.status !== "fail"),
  };
}
