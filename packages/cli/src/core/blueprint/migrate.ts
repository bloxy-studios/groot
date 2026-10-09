/**
 * Deterministic v1 → v2 groot.json migration (`groot migrate`).
 *
 * The v1 fields (`createdWith`, `conventions`, `scaffolds`) are carried over
 * verbatim — v2 is a strict superset, so consumers of the v1 fields keep
 * working. Each scaffold becomes an app (`origin: "generated"`) whose package
 * name and entry come from discovery when the scaffold is present on disk.
 * The output is a pure function of (manifest, observation, clock): the only
 * timestamp is the migration decision's `at`, and its id is content-derived,
 * so re-running with the same inputs yields byte-identical bytes.
 */
import { basename } from "node:path";
import {
  type BlueprintApp,
  type BlueprintV2,
  DEFAULT_CONTEXT,
  DEFAULT_POLICY,
  GROOT_JSON_SCHEMA_URL,
  type LegacyScaffold,
  type ManifestV1,
} from "../contracts/blueprint.ts";
import { type Decision, UnitPath } from "../contracts/common.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { joinRel } from "../fs/paths.ts";
import {
  allocateIds,
  assertBlueprint,
  decisionId,
  recordedStructuralContracts,
  slugify,
} from "./apps.ts";
import { MANIFEST_FILE } from "./manifest.ts";

export const MIGRATION_TOPIC = "migration.v1-to-v2";

/** Normalized project-relative path of a scaffold ("./apps/web/" → "apps/web"). */
function scaffoldPath(scaffold: LegacyScaffold, index: number): string {
  const parsed = UnitPath.safeParse(joinRel(scaffold.path));
  if (parsed.success && parsed.data !== ".") return parsed.data;
  throw new GrootV2Error(
    "GROOT_E_INVALID_DOCUMENT",
    `${MANIFEST_FILE} scaffold ${index} has path "${scaffold.path}", which is not a directory inside the project.`,
    {
      hint: "Fix the scaffold path in groot.json (a workspace-relative directory such as apps/web), then migrate again.",
      details: {
        path: MANIFEST_FILE,
        issues: [
          { path: `/scaffolds/${index}/path`, message: "expected a project-relative directory" },
        ],
      },
    },
  );
}

function projectName(observation: ProjectObservation): string {
  return observation.name.value ?? (basename(observation.root) || "project");
}

function migratedApps(v1: ManifestV1, observation: ProjectObservation): BlueprintApp[] {
  const paths = v1.scaffolds.map(scaffoldPath);
  const ids = allocateIds(
    v1.scaffolds.map(
      (scaffold, index) => slugify(basename(paths[index] as string)) || scaffold.slot,
    ),
  );
  return v1.scaffolds.map((scaffold, index) => {
    const path = paths[index] as string;
    const unit = observation.units.find((entry) => entry.path === path);
    return {
      id: ids[index] as string,
      path,
      kind: scaffold.slot,
      framework: scaffold.framework,
      packageName: unit?.packageName ?? null,
      port: scaffold.port,
      origin: "generated",
      entry: unit?.entry.value ?? null,
    };
  });
}

function migrationDecision(v1: ManifestV1, at: string): Decision {
  return {
    id: decisionId({ topic: MIGRATION_TOPIC, manifest: v1, at }),
    topic: MIGRATION_TOPIC,
    value: "groot.json migrated from version 1 to version 2",
    authority: "recipe",
    rationale:
      "Explicit groot migrate: createdWith, conventions, and scaffolds are kept verbatim; each scaffold became a generated app; no project file other than groot.json and groot.lock.json changed.",
    source: "groot migrate",
    at,
  };
}

/** Migrate a validated v1 manifest to a v2 blueprint (pure; `now` stamps the decision). */
export function migrateV1ToV2(
  v1: ManifestV1,
  observation: ProjectObservation,
  now: Date = new Date(),
): BlueprintV2 {
  const apps = migratedApps(v1, observation);
  const draft: BlueprintV2 = {
    $schema: GROOT_JSON_SCHEMA_URL,
    version: 2,
    createdWith: v1.createdWith,
    conventions: { ...v1.conventions },
    scaffolds: v1.scaffolds.map((scaffold) => ({ ...scaffold })),
    project: {
      name: projectName(observation),
      topology: "monorepo",
      packageManager: "bun",
      origin: "migrated",
    },
    apps,
    capabilities: [],
    decisions: [migrationDecision(v1, now.toISOString())],
    environment: [],
    verification: [],
    context: { ...DEFAULT_CONTEXT, skills: [...DEFAULT_CONTEXT.skills] },
    policy: { ...DEFAULT_POLICY, allow: [...DEFAULT_POLICY.allow] },
  };
  return assertBlueprint(
    { ...draft, verification: recordedStructuralContracts(draft, observation) },
    "groot migrate",
  );
}
