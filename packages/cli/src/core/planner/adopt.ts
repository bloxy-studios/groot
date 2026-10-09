/**
 * planAdopt — register an existing, certified project with Groot.
 *
 * The plan writes exactly two files, groot.json (the observed layout as a v2
 * blueprint) and groot.lock.json, and nothing else: no project file is
 * moved or rewritten, `.groot/` ignores itself (the project's .gitignore is
 * never edited), and uncommitted work — staged, unstaged, untracked — is
 * preserved untouched and listed in the plan. Every inference that went into
 * the blueprint without certainty is spelled out as an assumption, so the
 * human (or agent) reviewing the plan sees exactly what Groot guessed — and
 * so is every structural check already known to fail right after apply.
 *
 * Refusals are precise: an already-registered project is a conflict (see
 * `groot status`), a v1 workspace needs `groot migrate`, a broken groot.json
 * is reported as invalid, and an uncertified project gets the support
 * reasons and next step.
 */
import { blueprintFromObservation } from "../blueprint/adopt.ts";
import { knownStructuralGaps, withKnownGap } from "../blueprint/apps.ts";
import { emptyLock } from "../blueprint/lock.ts";
import { MANIFEST_FILE, readManifest } from "../blueprint/manifest.ts";
import { serializeBlueprint, serializeLock } from "../blueprint/serialize.ts";
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import { LOCK_FILE } from "../contracts/lock.ts";
import { OperationPlan, type PlanIntent } from "../contracts/plan.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { dirtyPathsOf, inspect, revisionOf } from "../discovery/index.ts";
import { GrootV2Error } from "../errors.ts";
import { type CoreContext, createdWith } from "../runtime.ts";
import { defaultContracts } from "../verify/checkers.ts";
import { PlanBuilder } from "./builder.ts";

export interface RegistrationPlanOptions {
  /** Clock for the blueprint decision and inspection (tests); defaults to the plan's creation time. */
  readonly now?: Date;
}

const MAX_LISTED_PATHS = 20;

/**
 * Builder for a plan whose only effects are groot.json + groot.lock.json.
 * `topology` defaults to the observed one (migration passes "monorepo":
 * every v1 workspace is one, whatever discovery can see today).
 */
export function registrationBuilder(
  observation: ProjectObservation,
  intent: PlanIntent,
  summary: string,
  topology: ProjectObservation["topology"]["value"] = observation.topology.value,
): PlanBuilder {
  if (topology === "unknown") {
    throw new GrootV2Error(
      "GROOT_E_UNSUPPORTED_PROJECT",
      `${observation.root} has no recognizable topology.`,
      {
        hint: observation.support.nextStep ?? undefined,
        details: { reasons: observation.support.reasons },
      },
    );
  }
  return new PlanBuilder({
    root: observation.root,
    intent,
    summary,
    topology,
    revision: revisionOf(observation),
    createdWith: createdWith(),
    dirtyPaths: new Set(dirtyPathsOf(observation)),
  });
}

/** groot owns its two files; every unit stays human-owned (recorded, never rewritten). */
export function registrationOwnership(builder: PlanBuilder, observation: ProjectObservation): void {
  for (const path of [MANIFEST_FILE, LOCK_FILE]) {
    builder.own({
      path,
      owner: "groot",
      parts: [],
      note: "machine-managed by groot; change it through groot plans, not by hand",
    });
  }
  for (const unit of observation.units) {
    builder.own({
      path: unit.path,
      owner: "human",
      parts: [],
      note:
        unit.path === "."
          ? "the project's own files — groot records this layout and never moves or rewrites them"
          : "recorded as-is — groot never moves or rewrites files here",
    });
  }
}

/**
 * Assumptions every registration plan states: dirty work preserved, local
 * state self-ignoring, and every way the disk contradicts the groot.json
 * being carried over (it is recorded as-is, never reconciled silently).
 */
export function registrationAssumptions(
  builder: PlanBuilder,
  observation: ProjectObservation,
): void {
  const dirty = dirtyPathsOf(observation);
  if (dirty.length > 0) {
    const listed = dirty.slice(0, MAX_LISTED_PATHS).join(", ");
    const more =
      dirty.length > MAX_LISTED_PATHS ? ` (+${dirty.length - MAX_LISTED_PATHS} more)` : "";
    builder.assume(
      `Uncommitted changes are preserved untouched (staged ${observation.git.staged.length}, unstaged ${observation.git.unstaged.length}, untracked ${observation.git.untracked.length}): ${listed}${more}.`,
    );
  }
  builder.assume(
    "Local operation state goes to .groot/, which ignores itself; the project's .gitignore is not edited.",
  );
  for (const contradiction of observation.contradictions) {
    if (contradiction.topic !== "blueprint") continue;
    builder.assume(
      `Recorded as groot.json has it although the disk disagrees: ${contradiction.explanation}.`,
    );
  }
}

/**
 * Structural checks that prove the registration (blueprint, env, ownership,
 * each app's package). A check already known to fail right after apply — a
 * package without a name, apps recorded with the same dev port — is declared
 * with the gap noted on it and stated as an assumption, so `groot verify`
 * reports nothing the plan did not announce.
 */
export function registrationVerification(builder: PlanBuilder, blueprint: BlueprintV2): void {
  const gaps = knownStructuralGaps(blueprint);
  const recorded = new Map(blueprint.verification.map((contract) => [contract.id, contract]));
  for (const contract of defaultContracts(blueprint)) {
    if (contract.profile !== "structural") continue;
    builder.verify(recorded.get(contract.id) ?? withKnownGap(contract, gaps.get(contract.id)));
  }
  for (const [id, gap] of gaps) {
    builder.assume(
      `Known gap: ${id} will fail right after apply — ${gap}. Registration records the project as it is and changes nothing to fix it.`,
    );
  }
}

/** Validate a plan Groot built; a failure is a Groot bug, never user error. */
export function validatedPlan(plan: OperationPlan): OperationPlan {
  const parsed = OperationPlan.safeParse(plan);
  if (parsed.success) return parsed.data;
  throw new GrootV2Error("GROOT_E_INTERNAL", "groot built a plan that violates its contract.", {
    hint: "This is a bug in groot — please report it with the command you ran.",
    details: {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    },
  });
}

interface FactLike {
  readonly confidence: string;
  readonly method: string;
  readonly source: string;
}

/** "label (confidence, method: source)" for each fact that is not certain, or null when all are. */
function uncertainLine(
  scope: string,
  facts: ReadonlyArray<readonly [string, FactLike]>,
): string | null {
  const uncertain = facts.filter(([, fact]) => fact.confidence !== "certain");
  if (uncertain.length === 0) return null;
  const described = uncertain.map(
    ([label, fact]) => `${label} (${fact.confidence}, ${fact.method}: ${fact.source})`,
  );
  return `${scope}: ${described.join("; ")}`;
}

/** Non-certain facts the adoption blueprint relies on: one line for the project, one per app. */
function inferredFacts(observation: ProjectObservation, blueprint: BlueprintV2): string[] {
  const lines = [
    uncertainLine("project", [
      [`name "${blueprint.project.name}"`, observation.name],
      [`topology ${observation.topology.value}`, observation.topology],
      [`package manager ${observation.packageManager.value}`, observation.packageManager],
    ]),
  ];
  for (const app of blueprint.apps) {
    const unit = observation.units.find((entry) => entry.path === app.path);
    if (unit === undefined) continue;
    const port = unit.ports.find((entry) => entry.value === app.port);
    lines.push(
      uncertainLine(app.path, [
        [`kind ${unit.kind.value}`, unit.kind],
        [`framework ${unit.framework.value?.id ?? "none"}`, unit.framework],
        [`entry ${unit.entry.value ?? "none"}`, unit.entry],
        ...(port === undefined ? [] : [[`port ${port.value}`, port] as const]),
      ]),
    );
  }
  return lines.filter((line): line is string => line !== null);
}

async function assertAdoptable(observation: ProjectObservation): Promise<void> {
  const { registration, support } = observation;
  if (registration.status === "v2") {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${observation.root} is already registered with groot (groot.json version 2).`,
      {
        hint: "Nothing to adopt — see the project's state with groot status (or groot inspect).",
        details: { registration },
      },
    );
  }
  if (registration.status === "v1") {
    throw new GrootV2Error(
      "GROOT_E_MIGRATION_REQUIRED",
      `${observation.root} is a groot v1 workspace (groot.json version 1).`,
      {
        hint: "Upgrade it explicitly with groot migrate --dry-run (preview), then groot migrate.",
        details: { registration },
      },
    );
  }
  if (registration.status === "invalid" || registration.status === "unsupported-version") {
    await readManifest(observation.root); // rethrows the precise GROOT_E_INVALID_DOCUMENT / GROOT_E_UNSUPPORTED_SCHEMA
    const reason = (registration.error ?? "invalid").replace(/\.$/, "");
    throw new GrootV2Error(
      "GROOT_E_INVALID_DOCUMENT",
      `groot.json in ${observation.root} could not be read: ${reason}.`,
      {
        details: { registration },
      },
    );
  }
  if (support.level !== "certified") {
    throw new GrootV2Error(
      "GROOT_E_UNSUPPORTED_PROJECT",
      `groot cannot adopt ${observation.root}: ${support.reasons.join("; ")}.`,
      {
        hint: support.nextStep ?? "Run groot inspect for details.",
        details: { level: support.level, reasons: support.reasons, nextStep: support.nextStep },
      },
    );
  }
}

/** Plan the registration of `dir` (resolved against ctx.cwd; no walk-up). */
export async function planAdopt(
  ctx: CoreContext,
  dir: string,
  options: RegistrationPlanOptions = {},
): Promise<OperationPlan> {
  const observation = await inspect(ctx, dir, options);
  await assertAdoptable(observation);
  const appCount = observation.units.filter((unit) => unit.kind.value !== "config").length;
  const builder = registrationBuilder(
    observation,
    { type: "adopt" },
    `Register ${observation.name.value ?? observation.root} with groot: record the existing ${observation.topology.value} layout (${appCount} app(s)) in groot.json and groot.lock.json — no other file changes.`,
  );
  const blueprint = blueprintFromObservation(observation, {
    now: options.now ?? new Date(builder.createdAt),
  });
  await builder.writeFile({
    path: MANIFEST_FILE,
    content: serializeBlueprint(blueprint),
    description: "write groot.json — the v2 blueprint recording the existing layout",
  });
  await builder.writeFile({
    path: LOCK_FILE,
    content: serializeLock(emptyLock()),
    description: "write groot.lock.json — empty: adoption resolves no generator or recipe",
  });
  builder.precondition({ type: "manifest", state: "absent", sha256: null });
  registrationOwnership(builder, observation);
  registrationAssumptions(builder, observation);
  for (const line of inferredFacts(observation, blueprint)) {
    builder.assume(`Inferred (not certain) and recorded in groot.json — ${line}.`);
  }
  registrationVerification(builder, blueprint);
  builder.setRecovery({
    mode: "full",
    summary:
      "Deleting groot.json and groot.lock.json restores the previous state — adoption changes no other file.",
    irreversible: [],
    limits: [],
  });
  return validatedPlan(builder.build());
}
