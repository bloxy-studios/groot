/**
 * Contract-valid fixtures for unit tests (never imported by runtime code).
 */
import {
  type BlueprintApp,
  type BlueprintV2,
  DEFAULT_CONTEXT,
  DEFAULT_POLICY,
  GROOT_JSON_SCHEMA_URL,
} from "./contracts/blueprint.ts";
import { schemaUrl } from "./contracts/common.ts";
import type { ProjectObservation, ProjectUnit } from "./contracts/project.ts";

const AT = "2026-10-07T00:00:00.000Z";

export function fixtureFact<T>(value: T): {
  value: T;
  source: string;
  method: "manifest";
  confidence: "certain";
  observedAt: string;
  fingerprint: null;
} {
  return {
    value,
    source: "fixture",
    method: "manifest",
    confidence: "certain",
    observedAt: AT,
    fingerprint: null,
  };
}

export function appFixture(
  overrides: Partial<BlueprintApp> & Pick<BlueprintApp, "id" | "path">,
): BlueprintApp {
  return {
    kind: "api",
    framework: "hono",
    packageName: overrides.id,
    port: 3001,
    origin: "adopted",
    entry: "src/index.ts",
    ...overrides,
  };
}

export function blueprintFixture(overrides: Partial<BlueprintV2> = {}): BlueprintV2 {
  return {
    $schema: GROOT_JSON_SCHEMA_URL,
    version: 2,
    createdWith: "create-groot@2.0.0",
    conventions: { packagesNamespace: "@repo" },
    scaffolds: [],
    project: { name: "fixture", topology: "monorepo", packageManager: "bun", origin: "adopted" },
    apps: [appFixture({ id: "api", path: "apps/api" })],
    capabilities: [],
    decisions: [],
    environment: [],
    verification: [],
    context: DEFAULT_CONTEXT,
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

export function unitFixture(
  overrides: Partial<ProjectUnit> & Pick<ProjectUnit, "path">,
): ProjectUnit {
  return {
    id: overrides.path,
    packageName: null,
    kind: fixtureFact("api" as const),
    framework: fixtureFact({ id: "hono", version: "^4.0.0" }),
    runtime: fixtureFact("bun" as const),
    language: "typescript",
    entry: fixtureFact("src/index.ts"),
    scripts: {},
    dependencies: { hono: "^4.0.0" },
    devDependencies: {},
    ports: [],
    envFiles: [],
    envVariables: [],
    ...overrides,
  };
}

export function observationFixture(
  units: ProjectUnit[],
  root = "/tmp/fixture",
): ProjectObservation {
  return {
    $schema: schemaUrl("project"),
    schemaVersion: 1,
    kind: "groot.project",
    root,
    observedAt: AT,
    grootVersion: "2.0.0",
    git: {
      vcs: "none",
      head: null,
      branch: null,
      dirty: false,
      worktreeFingerprint: null,
      staged: [],
      unstaged: [],
      untracked: [],
    },
    registration: { status: "v2", manifestPath: "groot.json", version: 2, error: null },
    name: fixtureFact("fixture"),
    packageManager: fixtureFact("bun" as const),
    topology: fixtureFact("monorepo" as const),
    workspaces: fixtureFact(["apps/*", "packages/*"]),
    units,
    toolchains: [],
    agentFiles: [],
    capabilities: [],
    support: { level: "certified", reasons: [], nextStep: null },
    unknowns: [],
    contradictions: [],
  };
}
