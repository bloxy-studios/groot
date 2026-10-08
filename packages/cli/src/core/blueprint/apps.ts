/**
 * Building blocks shared by migration (v1 → v2) and adoption: stable app ids,
 * content-derived decision ids, the per-app structural verification
 * contracts, and the final contract check every generated blueprint passes.
 *
 * Decision ids are derived from the decision's content instead of random
 * bytes so that the same inputs always produce byte-identical documents —
 * a migration re-planned against an unchanged project previews exactly the
 * same groot.json.
 */
import { type BlueprintApp, BlueprintV2 } from "../contracts/blueprint.ts";
import type { VerificationContract } from "../contracts/common.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { canonicalJson } from "../json.ts";
import { defaultContracts } from "../verify/checkers.ts";
import { zodIssues } from "./document.ts";

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
 * Per-app structural contracts, taken from the verification engine's own
 * defaults so ids and descriptions match (the engine dedupes by id).
 */
export function structuralPackageContracts(
  draft: BlueprintV2,
  apps: readonly BlueprintApp[],
): VerificationContract[] {
  const contracts = defaultContracts({ ...draft, apps: [...apps] });
  return contracts.filter((contract) => contract.checker === "structural.package");
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
