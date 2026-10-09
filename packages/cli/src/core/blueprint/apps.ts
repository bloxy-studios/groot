/**
 * Building blocks shared by migration (v1 → v2) and adoption: stable app ids,
 * content-derived decision ids, the structural verification contracts a
 * registration records (with the gaps they are known to fail on), and the
 * final contract check every generated blueprint passes.
 *
 * Decision ids are derived from the decision's content instead of random
 * bytes so that the same inputs always produce byte-identical documents —
 * a migration re-planned against an unchanged project previews exactly the
 * same groot.json.
 */
import { BlueprintV2 } from "../contracts/blueprint.ts";
import type { VerificationContract } from "../contracts/common.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { joinRel } from "../fs/paths.ts";
import { canonicalJson } from "../json.ts";
import { portCollisions } from "../ports.ts";
import { defaultContracts } from "../verify/checkers.ts";
import { zodIssues } from "./document.ts";
import { missingRecordedPaths } from "./presence.ts";

/** Lowercase, dash-separated id material ("My API!" → "my-api"); "" when nothing usable remains. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Package name without its npm scope ("@acme/edge" → "edge"). */
export function packageBaseName(name: string): string {
  const slash = name.indexOf("/");
  return name.startsWith("@") && slash > 0 ? name.slice(slash + 1) : name;
}

/** Make ids unique in order: the second "web" becomes "web-2", the third "web-3". */
export function allocateIds(bases: readonly string[]): string[] {
  const taken = new Set<string>();
  return bases.map((base) => {
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
    taken.add(id);
    return id;
  });
}

/** `dec_<24 hex>` derived from the decision's identifying content. */
export function decisionId(seed: unknown): string {
  return `dec_${sha256Of(canonicalJson(seed)).slice("sha256:".length, "sha256:".length + 24)}`;
}

/**
 * Structural checks a blueprint recorded from the project as it is will fail
 * as soon as it is written, keyed by contract id, with the reason — the
 * conditions the checks themselves test. structural.blueprint fails for an
 * app whose directory is missing and for apps recorded with the same dev
 * port; structural.package.<id> fails for an app whose directory or
 * package.json is missing, or that has no package name. Pure: missing paths
 * come from the observation's contradictions (see presence.ts), everything
 * else from the blueprint alone (without an observation, nothing counts as
 * missing).
 */
export function knownStructuralGaps(
  blueprint: BlueprintV2,
  observation?: ProjectObservation,
): Map<string, string> {
  const missing = observation === undefined ? new Set<string>() : missingRecordedPaths(observation);
  const gaps = new Map<string, string>();
  const blueprintProblems: string[] = [];
  for (const app of blueprint.apps) {
    const manifest = joinRel(app.path, "package.json");
    const packageCheck = `structural.package.${app.id}`;
    if (missing.has(app.path)) {
      blueprintProblems.push(`${app.id}: ${app.path} is missing`);
      gaps.set(packageCheck, `${app.path} is missing`);
    } else if (missing.has(manifest)) {
      gaps.set(packageCheck, `${manifest} is missing`);
    } else if (app.packageName === null) {
      gaps.set(packageCheck, `no package name was observed in ${manifest}`);
    }
  }
  for (const [port, paths] of portCollisions(blueprint)) {
    blueprintProblems.push(`dev port ${port} is declared by ${paths.join(" and ")}`);
  }
  if (blueprintProblems.length > 0) gaps.set("structural.blueprint", blueprintProblems.join("; "));
  return gaps;
}

const KNOWN_GAP = " — known gap when recorded: ";

/** `contract`, its description noting the gap it was known to fail on when recorded. */
export function withKnownGap(
  contract: VerificationContract,
  gap: string | undefined,
): VerificationContract {
  return gap === undefined
    ? contract
    : { ...contract, description: `${contract.description}${KNOWN_GAP}${gap}` };
}

/** The gap `contract`'s description notes (see withKnownGap), or null when it notes none. */
export function knownGapOf(contract: VerificationContract): string | null {
  const at = contract.description.indexOf(KNOWN_GAP);
  return at === -1 ? null : contract.description.slice(at + KNOWN_GAP.length);
}

/**
 * The structural contracts a registration blueprint records: every app's
 * structural.package check, and structural.blueprint when it is already known
 * to fail. Taken from the verification engine's own defaults so ids match
 * (the engine dedupes by id, the blueprint's entry first) — and descriptions
 * too, except that a check known to fail says so: after apply, `groot verify`
 * reads the description from groot.json and reports the failure as announced.
 */
export function recordedStructuralContracts(
  blueprint: BlueprintV2,
  observation: ProjectObservation,
): VerificationContract[] {
  const gaps = knownStructuralGaps(blueprint, observation);
  return defaultContracts(blueprint)
    .filter(
      (contract) =>
        contract.checker === "structural.package" ||
        (contract.checker === "structural.blueprint" && gaps.has(contract.id)),
    )
    .map((contract) => withKnownGap(contract, gaps.get(contract.id)));
}

/** Validate a blueprint Groot generated; a failure is a Groot bug, never user error. */
export function assertBlueprint(doc: BlueprintV2, origin: string): BlueprintV2 {
  const parsed = BlueprintV2.safeParse(doc);
  if (parsed.success) return parsed.data;
  throw new GrootV2Error(
    "GROOT_E_INTERNAL",
    `${origin} produced a blueprint that violates its contract.`,
    {
      hint: "This is a bug in groot — please report it with the output of groot inspect --json.",
      details: { issues: zodIssues(parsed.error) },
    },
  );
}
