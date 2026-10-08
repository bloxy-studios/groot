/**
 * Planning rules shared by the built-in recipes. Every change still goes
 * through the PlanBuilder (exact previews, preconditions, step ids); these
 * helpers add the recipe-level policy on top of it:
 *
 * - files Groot owns are recorded in the RecipeLock with the hash of exactly
 *   the bytes Groot writes;
 * - starter files (the schema barrel, drizzle-kit's journal) are created once
 *   and then belong to the human or the tool that maintains them;
 * - package.json is shared: scripts are added, never replaced, and an
 *   existing script with different content is a precise conflict.
 */
import type { Decision } from "../contracts/common.ts";
import type { OwnedArtifact } from "../contracts/lock.ts";
import type { DependencyChange, JsonOp } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { canonicalJson } from "../json.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import type { RecipeLayout } from "./layout.ts";

export interface PlannedFile {
  readonly path: string;
  readonly content: string;
  readonly description: string;
}

/** Write a file Groot owns; returns its lock record (also when it already had these bytes). */
export async function writeOwned(builder: PlanBuilder, file: PlannedFile): Promise<OwnedArtifact> {
  await builder.writeFile({ ...file, ownership: "file" });
  return { path: file.path, ownership: "file", parts: [], sha256: sha256Of(file.content) };
}

/** Create a starter file that belongs to someone else from then on (never recorded in the lock). */
export async function writeStarter(
  builder: PlanBuilder,
  file: PlannedFile,
  owner: { owner: "human" | "shared"; parts: string[]; note: string },
): Promise<void> {
  await builder.writeFile({ ...file, ownership: "none" });
  builder.own({ path: file.path, ...owner });
}

/** RFC 6901 token escaping ("@types/bun" → "@types~1bun"). */
export function pointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface PackageManifest {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

async function readManifest(builder: PlanBuilder, path: string): Promise<PackageManifest> {
  const text = await builder.currentContent(path);
  if (text === null) {
    throw new GrootV2Error("GROOT_E_CONFLICT", `${path} does not exist.`, {
      details: { path, conflict: "missing-file" },
    });
  }
  try {
    return JSON.parse(text) as PackageManifest;
  } catch (error) {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      { details: { path, conflict: "transform", reason: "unparseable JSON" } },
    );
  }
}

/**
 * Add package.json scripts. Identical scripts are a no-op; a different script
 * under the same name is a conflict — Groot never rewrites a human's script.
 * When an earlier step of this plan produced package.json (a deps.add the
 * builder can't preview), the edit is deferred to execution time so it lands
 * on the real current file instead of a stale preview.
 */
export async function ensureScripts(
  builder: PlanBuilder,
  layout: RecipeLayout,
  scripts: Readonly<Record<string, string>>,
  recipeId: string,
): Promise<string[]> {
  const path = layout.packageJson;
  const existing = (await readManifest(builder, path)).scripts ?? {};
  const ops: JsonOp[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    const current = existing[name];
    if (current === command) continue;
    if (current !== undefined) {
      throw new GrootV2Error(
        "GROOT_E_CONFLICT",
        `${path} already defines the "${name}" script as "${current}"; ${recipeId} needs "${command}".`,
        {
          hint: "Rename or remove your script (or make it identical), then plan again — Groot never overwrites a script it didn't write.",
          details: { path, conflict: "script", script: name },
        },
      );
    }
    ops.push({ op: "set", pointer: `/scripts/${pointerToken(name)}`, value: command });
  }
  const pointers = Object.keys(scripts).map((name) => `/scripts/${pointerToken(name)}`);
  if (ops.length === 0) return pointers;
  const expect = await builder.expectationFor(path);
  await builder.editFile({
    path,
    edit: { kind: "json", ops },
    description: `add the ${ops.map((op) => op.pointer.slice("/scripts/".length)).join(", ")} script(s) to ${path}`,
    owns: ops.map((op) => op.pointer),
    createIfMissing: false,
    deferred: expect.state === "produced",
  });
  return pointers;
}

export interface PinnedDependency {
  readonly name: string;
  readonly version: string;
  readonly dev: boolean;
}

/**
 * One deps.add step with exact versions. A package already at the pinned
 * version is skipped; one present elsewhere keeps its section (dependencies
 * vs devDependencies) and records its previous range for rollback.
 */
export async function addDependencies(
  builder: PlanBuilder,
  layout: RecipeLayout,
  pins: readonly PinnedDependency[],
): Promise<string[]> {
  const manifest = await readManifest(builder, layout.packageJson);
  const placed = pins.map((pin) => {
    const inDeps = manifest.dependencies?.[pin.name];
    const inDev = manifest.devDependencies?.[pin.name];
    const dev = inDeps !== undefined ? false : inDev !== undefined ? true : pin.dev;
    return { pin, dev, current: inDeps ?? inDev ?? null };
  });
  const changes: DependencyChange[] = placed
    .filter(({ pin, current }) => current !== pin.version)
    .map(({ pin, dev, current }) => ({
      unit: layout.appDir,
      package: pin.name,
      from: current,
      to: pin.version,
      dev,
    }));
  const pointers = placed.map(
    ({ pin, dev }) => `/${dev ? "devDependencies" : "dependencies"}/${pointerToken(pin.name)}`,
  );
  if (changes.length === 0) return pointers;
  builder.add({
    type: "deps.add",
    unit: layout.appDir,
    changes,
    expect: await builder.expectationFor(layout.packageJson),
    description: `add ${changes.map((change) => `${change.package}@${change.to}${change.dev ? " (dev)" : ""}`).join(", ")} to ${layout.packageJson}`,
    classes: ["deps.change"],
    reversible: true,
    compensation: `restore the previous ${layout.packageJson} from backup if unchanged since apply, then re-run bun install`,
  });
  return pointers;
}

/** Content-derived decision id: re-planning the same recipe on the same app yields the same id. */
export function decisionId(seed: unknown): string {
  const hex = sha256Of(canonicalJson(seed)).slice("sha256:".length);
  return `dec_${hex.slice(0, 24)}`;
}

export interface RecipeDecisionInput {
  readonly recipe: string;
  readonly version: string;
  readonly app: string;
  readonly topic: string;
  readonly value: string;
  readonly rationale: string;
  readonly at: string;
}

export function recipeDecision(input: RecipeDecisionInput): Decision {
  return {
    id: decisionId({ recipe: input.recipe, app: input.app, topic: input.topic }),
    topic: input.topic,
    value: input.value,
    authority: "recipe",
    rationale: input.rationale,
    source: `${input.recipe}@${input.version}`,
    at: input.at,
  };
}
