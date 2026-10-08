/**
 * The blueprint `groot adopt` records for an existing project: the layout
 * exactly as discovery observed it. Units become apps (`origin: "adopted"`)
 * at their real paths with their real entries — custom directory names and
 * scripts are preserved, nothing is moved — except shared config packages
 * (tsconfig/eslint presets), which are not apps. A single-app root becomes
 * one app at ".".
 */
import { basename } from "node:path";
import {
  type BlueprintApp,
  type BlueprintV2,
  Conventions,
  DEFAULT_CONTEXT,
  DEFAULT_POLICY,
  GROOT_JSON_SCHEMA_URL,
} from "../contracts/blueprint.ts";
import type { Confidence, Decision } from "../contracts/common.ts";
import type { ProjectObservation, ProjectUnit } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { createdWith } from "../runtime.ts";
import {
  allocateIds,
  assertBlueprint,
  decisionId,
  packageBaseName,
  slugify,
  structuralPackageContracts,
} from "./apps.ts";

export const ADOPTION_TOPIC = "adoption.layout";

/** Groot's default shared-package namespace when the project has no scoped packages. */
export const DEFAULT_NAMESPACE = "@repo";

const CONFIDENCE_RANK: Record<Confidence, number> = { certain: 3, high: 2, medium: 1, low: 0 };

export interface AdoptionOptions {
  /** Clock for the adoption decision (defaults to now). */
  readonly now?: Date;
}

function appIdBase(unit: ProjectUnit): string {
  if (unit.path === ".") return slugify(packageBaseName(unit.packageName ?? "")) || "app";
  return slugify(basename(unit.path)) || "app";
}

/** The most confident observed port; ties keep discovery's order (dev script first). */
export function preferredPort(unit: ProjectUnit): number | null {
  let best: ProjectUnit["ports"][number] | null = null;
  for (const port of unit.ports) {
    if (best === null || CONFIDENCE_RANK[port.confidence] > CONFIDENCE_RANK[best.confidence]) {
      best = port;
    }
  }
  return best?.value ?? null;
}

/** Most common npm scope among the project's packages ("@acme/ui" → "@acme"), else "@repo". */
function packagesNamespace(units: readonly ProjectUnit[]): string {
  const counts = new Map<string, number>();
  for (const unit of units) {
    const scope = /^(@[^/]+)\//.exec(unit.packageName ?? "")?.[1];
    if (scope === undefined || !Conventions.shape.packagesNamespace.safeParse(scope).success) {
      continue;
    }
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const ranked = [...counts].sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return ranked[0]?.[0] ?? DEFAULT_NAMESPACE;
}

function adoptedApps(units: readonly ProjectUnit[]): BlueprintApp[] {
  const ids = allocateIds(units.map(appIdBase));
  return units.map((unit, index) => ({
    id: ids[index] as string,
    path: unit.path,
    kind: unit.kind.value,
    framework: unit.framework.value?.id ?? null,
    packageName: unit.packageName,
    port: preferredPort(unit),
    origin: "adopted",
    entry: unit.entry.value,
  }));
}

function adoptionDecision(apps: readonly BlueprintApp[], at: string): Decision {
  return {
    id: decisionId({ topic: ADOPTION_TOPIC, apps: apps.map((app) => app.path), at }),
    topic: ADOPTION_TOPIC,
    value: "preserve the existing layout",
    authority: "default",
    rationale:
      "Adoption records the project as it is: directory names, scripts, entries, and configuration stay untouched. Moving or renaming files would be a separate, explicit operation.",
    source: "groot adopt",
    at,
  };
}

/** Blueprint for adopting an observed (certified) project. Pure apart from the clock. */
export function blueprintFromObservation(
  observation: ProjectObservation,
  opts: AdoptionOptions = {},
): BlueprintV2 {
  const topology = observation.topology.value;
  if (topology === "unknown") {
    throw new GrootV2Error(
      "GROOT_E_UNSUPPORTED_PROJECT",
      `Cannot describe ${observation.root} as a blueprint: its topology is unknown.`,
      {
        hint: observation.support.nextStep ?? "Run groot inspect to see what is missing.",
        details: { reasons: observation.support.reasons },
      },
    );
  }
  const units = observation.units.filter((unit) => unit.kind.value !== "config");
  const apps = adoptedApps(units);
  const at = (opts.now ?? new Date()).toISOString();
  const draft: BlueprintV2 = {
    $schema: GROOT_JSON_SCHEMA_URL,
    version: 2,
    createdWith: createdWith(),
    conventions: { packagesNamespace: packagesNamespace(observation.units) },
    scaffolds: [],
    project: {
      name: observation.name.value ?? (basename(observation.root) || "project"),
      topology,
      packageManager: "bun",
      origin: "adopted",
    },
    apps,
    capabilities: [],
    decisions: [adoptionDecision(apps, at)],
    environment: [],
    verification: [],
    context: { ...DEFAULT_CONTEXT, skills: [...DEFAULT_CONTEXT.skills] },
    policy: { ...DEFAULT_POLICY, allow: [...DEFAULT_POLICY.allow] },
  };
  return assertBlueprint(
    { ...draft, verification: structuralPackageContracts(draft, apps) },
    "groot adopt",
  );
}
