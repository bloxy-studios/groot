/**
 * Bridge from the v1 scaffold pipeline to the v2 blueprint (groot.json
 * version 2). Fresh workspaces get a blueprint derived from the plan; a v2
 * workspace grown by `groot add` keeps everything it already records and
 * gains the new scaffold, its app entry, and its environment contracts.
 *
 * The blueprint is a strict superset of the v1 manifest: `createdWith`,
 * `conventions`, and `scaffolds` keep their v1 meaning (docs/v2-cli-spec.md#compatibility-with-v1).
 */
import { basename } from "node:path";
import {
  type BlueprintApp,
  BlueprintV2,
  DEFAULT_CONTEXT,
  DEFAULT_POLICY,
  GROOT_JSON_SCHEMA_URL,
} from "../core/contracts/blueprint.ts";
import type { EnvVarContract } from "../core/contracts/common.ts";
import { hasPublicPrefix } from "../core/env.ts";
import { backendEnvLines } from "./env-names.ts";
import type { Plan, PlannedScaffold } from "./types.ts";

/** Server entries groot's adapters create (recipes mount into these). */
const ENTRY_BY_FRAMEWORK: Partial<Record<PlannedScaffold["framework"], string>> = {
  hono: "src/index.ts",
  elysia: "src/index.ts",
  fastify: "src/server.ts",
};

/** Where each backend's values come from — told to the user when they are missing. */
const SOURCE_BY_BACKEND: Partial<Record<PlannedScaffold["framework"], string>> = {
  convex: "the deployment URL `bun run setup` writes to the backend package after Convex login",
  supabase: "printed by `bun run dev` in the backend package (supabase start)",
};

function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(cleaned) ? cleaned : "app";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function appFor(plan: Plan, scaffold: PlannedScaffold, used: Set<string>): BlueprintApp {
  const single = scaffold.path === ".";
  const packageName = single
    ? plan.name
    : scaffold.slot === "backend"
      ? `${plan.conventions.packagesNamespace}/backend`
      : basename(scaffold.path);
  return {
    id: uniqueId(single ? slug(plan.name) : slug(basename(scaffold.path)), used),
    path: scaffold.path,
    kind: scaffold.slot,
    framework: scaffold.framework,
    packageName,
    port: scaffold.port,
    origin: "generated",
    entry: ENTRY_BY_FRAMEWORK[scaffold.framework] ?? null,
  };
}

/**
 * Environment contracts implied by the backend wiring the stitch stage
 * plants: each frontend reads the backend's public URL/key under the prefix
 * its framework exposes, from its own `.env.local`. Required and unset until
 * the backend is configured — `groot verify` reports them as blocked, which
 * is the truth about a freshly planted workspace.
 */
export function backendEnvContracts(plan: Plan): EnvVarContract[] {
  const backend = plan.scaffolds.find((scaffold) => scaffold.slot === "backend");
  if (backend === undefined) return [];
  const source = SOURCE_BY_BACKEND[backend.framework] ?? "the backend's configuration";
  const contracts: EnvVarContract[] = [];
  for (const scaffold of plan.scaffolds) {
    if (scaffold.slot !== "web" && scaffold.slot !== "mobile") continue;
    for (const line of backendEnvLines(backend.framework, scaffold)) {
      const name = line.replace(/=$/, "");
      contracts.push({
        name,
        consumer: scaffold.path,
        // A name without a client prefix (bare React Native) is inlined at build time by the user's env library.
        scope: hasPublicPrefix(name) ? "public" : "build",
        sensitivity: "config",
        required: true,
        description: `${backend.framework} connection for ${scaffold.path} — ${source}`,
        storage: `${scaffold.path}/.env.local`,
        example: "",
        generate: "none",
        declaredBy: `adapter.${backend.framework}`,
      });
    }
  }
  return contracts;
}

function mergeEnv(
  existing: readonly EnvVarContract[],
  added: readonly EnvVarContract[],
): EnvVarContract[] {
  const key = (contract: EnvVarContract): string => `${contract.consumer}:${contract.name}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...added.filter((contract) => !seen.has(key(contract)))];
}

/** The blueprint groot.json should contain after this plan's stitch stage. */
export function planToBlueprint(plan: Plan): BlueprintV2 {
  const existing = plan.blueprint ?? null;
  if (existing !== null) {
    const used = new Set(existing.apps.map((app) => app.id));
    const known = new Set(existing.apps.map((app) => app.path));
    const added = plan.scaffolds
      .filter((scaffold) => !known.has(scaffold.path))
      .map((scaffold) => appFor(plan, scaffold, used));
    return BlueprintV2.parse({
      ...existing,
      scaffolds: [...plan.scaffolds],
      apps: [...existing.apps, ...added],
      environment: mergeEnv(existing.environment, backendEnvContracts(plan)),
    });
  }
  const used = new Set<string>();
  return BlueprintV2.parse({
    $schema: GROOT_JSON_SCHEMA_URL,
    version: 2,
    createdWith: plan.createdWith,
    conventions: plan.conventions,
    scaffolds: [...plan.scaffolds],
    project: {
      name: plan.name,
      topology: plan.topology ?? "monorepo",
      packageManager: "bun",
      origin: "created",
    },
    apps: plan.scaffolds.map((scaffold) => appFor(plan, scaffold, used)),
    capabilities: [],
    decisions: [],
    environment: backendEnvContracts(plan),
    verification: [],
    context: DEFAULT_CONTEXT,
    policy: DEFAULT_POLICY,
  });
}
