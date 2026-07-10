/**
 * Resolve stage: merge slot selections + options into an immutable Plan, and
 * project plans into the groot.json manifest shape (docs/cli-spec.md#grootjson-manifest).
 */
import { EXIT, GrootError } from "./errors.ts";
import { choiceIdsFor, findChoice, SLOT_ORDER, YES_DEFAULTS } from "./matrix.ts";
import {
  MANIFEST_SCHEMA_URL,
  MANIFEST_VERSION,
  type Manifest,
  NONE,
  type Plan,
  type PlannedScaffold,
  type PlanOptions,
  type Slot,
} from "./types.ts";

/** Per-slot selections as provided by flags (undefined = undecided → prompt or default). */
export type SlotSelections = Partial<Record<Slot, string>>;

/** The default namespace for shared packages in scaffolded workspaces. */
export const PACKAGES_NAMESPACE = "@repo";

/** Throw EXIT.USAGE when any provided selection isn't offered by its slot. */
export function validateSelections(selections: SlotSelections): void {
  for (const slot of SLOT_ORDER) {
    const value = selections[slot];
    if (value === undefined) continue;
    if (value !== NONE && findChoice(slot, value) === undefined) {
      throw new GrootError(
        `Invalid value for --${slot}: "${value}"`,
        EXIT.USAGE,
        `Valid choices: ${choiceIdsFor(slot).join(" | ")}`,
      );
    }
  }
}

/** Slots that still need a decision (no flag provided). */
export function undecidedSlots(selections: SlotSelections): Slot[] {
  return SLOT_ORDER.filter((slot) => selections[slot] === undefined);
}

/** Fill undecided slots with the `--yes` defaults. */
export function applyYesDefaults(selections: SlotSelections): Record<Slot, string> {
  const resolved = {} as Record<Slot, string>;
  for (const slot of SLOT_ORDER) {
    resolved[slot] = selections[slot] ?? YES_DEFAULTS[slot];
  }
  return resolved;
}

/** Build the ordered scaffold list from fully-decided selections. */
export function buildScaffolds(selections: Record<Slot, string>): PlannedScaffold[] {
  const scaffolds: PlannedScaffold[] = [];
  for (const slot of SLOT_ORDER) {
    const value = selections[slot];
    if (value === NONE) continue;
    const choice = findChoice(slot, value);
    if (choice === undefined) {
      // validateSelections guards flag input; reaching this means a programming error.
      throw new GrootError(`Unknown ${slot} choice "${value}"`, EXIT.INTERNAL);
    }
    scaffolds.push({
      slot,
      framework: choice.id,
      path: choice.path,
      generator: choice.generator,
      port: choice.port,
    });
  }
  return scaffolds;
}

export interface BuildPlanInput {
  readonly name: string;
  readonly targetDir: string;
  readonly cliVersion: string;
  readonly selections: Record<Slot, string>;
  readonly options: PlanOptions;
}

/** Assemble the immutable Plan (resolve stage output). */
export function buildPlan(input: BuildPlanInput): Plan {
  return {
    name: input.name,
    targetDir: input.targetDir,
    createdWith: `create-groot@${input.cliVersion}`,
    conventions: { packagesNamespace: PACKAGES_NAMESPACE },
    scaffolds: buildScaffolds(input.selections),
    options: input.options,
  };
}

/** Project a Plan into the groot.json manifest (also the `--dry-run --json` output). */
export function planToManifest(plan: Plan): Manifest {
  return {
    $schema: MANIFEST_SCHEMA_URL,
    version: MANIFEST_VERSION,
    createdWith: plan.createdWith,
    conventions: plan.conventions,
    scaffolds: plan.scaffolds,
  };
}

/** Human-readable plan summary for the confirm step and dry runs. */
export function describePlan(plan: Plan): string {
  const lines: string[] = [`name       ${plan.name}`, `target     ${plan.targetDir}`];
  if (plan.scaffolds.length === 0) {
    lines.push("scaffolds  (none — an empty turborepo trunk)");
  }
  for (const scaffold of plan.scaffolds) {
    const port = scaffold.port === null ? "" : `  :${scaffold.port}`;
    const source = scaffold.generator ?? "groot-authored files";
    const label = findChoice(scaffold.slot, scaffold.framework)?.label ?? scaffold.framework;
    lines.push(`${scaffold.slot.padEnd(9)}  ${label} → ${scaffold.path}${port}  (${source})`);
  }
  const skips: string[] = [];
  if (!plan.options.install) skips.push("install");
  if (!plan.options.git) skips.push("git init");
  if (skips.length > 0) lines.push(`skipping   ${skips.join(", ")}`);
  return lines.join("\n");
}
