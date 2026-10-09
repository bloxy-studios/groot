/**
 * core/discovery — read-only, static project inspection (`groot inspect`).
 *
 * Discovery never imports or executes repository code: it reads manifests,
 * lockfile names, scripts (as text), entry sources (as text), and agent
 * files through a project-bounded reader. The only processes it starts are
 * git (core/git.ts) and toolchain version probes (toolchains.ts). The git
 * probes are hardened against repository configuration (no hooks, fsmonitor,
 * external diff, or textconv) with one exception flags cannot switch off:
 * clean/smudge/process filter drivers configured in the repository's own
 * .git/config may run during `git status`/`git diff` — so an untrusted
 * `.git` should be cloned (`git clone --no-local`) before it is inspected.
 * Skipped everywhere: node_modules, .git, .groot, .claude/worktrees, dist,
 * build, .turbo, .next, .svelte-kit, .output.
 *
 * The result is a ProjectObservation — observed state with provenance — that
 * is validated against its contract before it is returned. Observations
 * never overwrite desired state: disagreements with groot.json are listed as
 * contradictions for an explicit plan to reconcile.
 */
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { RelPath, type RevisionInfo, schemaUrl } from "../contracts/common.ts";
import { type GitState, ProjectObservation } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { gitState } from "../git.ts";
import type { CoreContext } from "../runtime.ts";
import { findAgentFiles } from "./agent-files.ts";
import { observeCapabilities } from "./capabilities.ts";
import { type FactFactory, factFactory, type ObservedFact } from "./facts.ts";
import { ProjectFs } from "./fs.ts";
import { analyzeNativeRoot, type NativeMarker, nativeMarkers } from "./native.ts";
import { detectPackageManager, type RootManifest } from "./package-manager.ts";
import { manifestContradictions, observeRegistration } from "./registration.ts";
import { assessSupport, notADirectory } from "./support.ts";
import { probeToolchains } from "./toolchains.ts";
import { analyzePackageUnit, type UnitAnalysis } from "./units.ts";
import { detectTopology, type TopologyFindings } from "./workspaces.ts";

export interface InspectOptions {
  /** Observation clock (tests); defaults to now. */
  readonly now?: Date;
}

const NO_GIT: GitState = {
  vcs: "none",
  head: null,
  branch: null,
  dirty: false,
  worktreeFingerprint: null,
  staged: [],
  unstaged: [],
  untracked: [],
};

type Location = { readonly kind: "dir" | "file" | "missing"; readonly root: string };

async function locate(target: string): Promise<Location> {
  try {
    const root = await realpath(target);
    return { kind: (await stat(root)).isDirectory() ? "dir" : "file", root };
  } catch {
    return { kind: "missing", root: target };
  }
}

function validated(observation: ProjectObservation): ProjectObservation {
  const parsed = ProjectObservation.safeParse(observation);
  if (parsed.success) return parsed.data;
  throw new GrootV2Error("GROOT_E_INTERNAL", "Discovery produced an invalid project observation.", {
    hint: "This is a bug in groot — please report it with the project layout that triggered it.",
    details: {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    },
  });
}

function emptyObservation(
  ctx: CoreContext,
  location: Location,
  observedAt: string,
  fact: FactFactory,
): ProjectObservation {
  const none = { source: location.root, method: "filesystem" as const, confidence: "low" as const };
  return {
    $schema: schemaUrl("project"),
    schemaVersion: 1,
    kind: "groot.project",
    root: location.root,
    observedAt,
    grootVersion: ctx.grootVersion,
    git: NO_GIT,
    registration: { status: "unregistered", manifestPath: null, version: null, error: null },
    name: fact({ ...none, value: basename(location.root) || null }),
    packageManager: fact({ ...none, value: "unknown" }),
    topology: fact({ ...none, value: "unknown" }),
    workspaces: fact({ ...none, value: [] }),
    units: [],
    toolchains: [],
    agentFiles: [],
    capabilities: [],
    support: notADirectory(location.root, location.kind === "file"),
    unknowns: [],
    contradictions: [],
  };
}

/** Git state with any path the contracts can't represent dropped (and noted). */
async function observeGit(fs: ProjectFs): Promise<GitState> {
  const state = await gitState(fs.root);
  const keep = (paths: readonly string[]): string[] =>
    paths.filter((path) => {
      if (RelPath.safeParse(path).success) return true;
      fs.note(`git reported a path groot cannot represent: ${JSON.stringify(path)}`);
      return false;
    });
  return {
    ...state,
    staged: keep(state.staged),
    unstaged: keep(state.unstaged),
    untracked: keep(state.untracked),
  };
}

async function readRootManifest(fs: ProjectFs, problems: string[]): Promise<RootManifest | null> {
  const file = await fs.readText("package.json");
  if (file === null) return null;
  try {
    const value: unknown = JSON.parse(file.text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { value: value as Record<string, unknown>, sha256: file.sha256 };
    }
  } catch {
    // reported below; the file still makes this a (broken) single-package root
  }
  problems.push("package.json is not a valid JSON object");
  return { value: {}, sha256: file.sha256 };
}

function nameFact(
  fact: FactFactory,
  root: string,
  manifest: RootManifest | null,
): ObservedFact<string | null> {
  const name = manifest?.value.name;
  if (typeof name === "string" && name !== "") {
    return fact({
      value: name,
      source: "package.json#name",
      method: "manifest",
      confidence: "certain",
      fingerprint: manifest?.sha256 ?? null,
    });
  }
  return fact({
    value: basename(root) || null,
    source: "directory name",
    method: "filesystem",
    confidence: "low",
  });
}

async function analyzeUnits(
  fs: ProjectFs,
  fact: FactFactory,
  topology: TopologyFindings,
  packageManager: ProjectObservation["packageManager"]["value"],
  markers: readonly NativeMarker[],
): Promise<UnitAnalysis[]> {
  if (topology.topology.value === "unknown") {
    return markers.length === 0 ? [] : [await analyzeNativeRoot(fs, fact, markers)];
  }
  const ctx = { fs, fact, packageManager };
  return Promise.all(topology.unitPaths.map((path) => analyzePackageUnit(ctx, path)));
}

function toolchainNeeds(analyses: readonly UnitAnalysis[]): Map<string, Set<string>> {
  const needs = new Map<string, Set<string>>([
    ["bun", new Set(["groot"])],
    ["git", new Set(["groot"])],
  ]);
  const need = (id: string, by: string): void => {
    const set = needs.get(id) ?? new Set<string>();
    set.add(by);
    needs.set(id, set);
  };
  for (const { unit, toolchains } of analyses) {
    const runtime = unit.runtime.value;
    if (runtime === "bun" || runtime === "node") need(runtime, unit.path);
    for (const id of toolchains) need(id, unit.path);
  }
  return needs;
}

async function rootEnvNote(fs: ProjectFs, topology: TopologyFindings): Promise<string[]> {
  if (topology.topology.value !== "monorepo") return [];
  const files = (await fs.list("."))
    .filter((entry) => entry.type === "file" && /^\.env(?:\..+)?$/.test(entry.name))
    .map((entry) => entry.name);
  return files.length === 0
    ? []
    : [`root env files are not attributed to a unit (names only): ${files.join(", ")}`];
}

/** Inspect `dir` (resolved against ctx.cwd; no walk-up) into a validated ProjectObservation. */
export async function inspect(
  ctx: CoreContext,
  dir: string,
  options: InspectOptions = {},
): Promise<ProjectObservation> {
  const observedAt = (options.now ?? new Date()).toISOString();
  const fact = factFactory(observedAt);
  const location = await locate(resolve(ctx.cwd, dir));
  if (location.kind !== "dir") return validated(emptyObservation(ctx, location, observedAt, fact));
  ctx.events.emit({
    type: "discovery.started",
    level: "debug",
    message: `inspecting ${location.root}`,
  });

  const fs = new ProjectFs(location.root);
  const problems: string[] = [];
  const [git, registration, rootManifest] = await Promise.all([
    observeGit(fs),
    observeRegistration(location.root),
    readRootManifest(fs, problems),
  ]);
  const pm = await detectPackageManager(fs, rootManifest, fact);
  const topology = await detectTopology(fs, rootManifest, fact);
  const markers = topology.topology.value === "unknown" ? await nativeMarkers(fs) : [];
  const analyses = await analyzeUnits(fs, fact, topology, pm.fact.value, markers);
  const units = analyses.map((analysis) => analysis.unit);
  const agentFiles = await findAgentFiles(fs);
  const toolchains = await probeToolchains(toolchainNeeds(analyses), ctx.env, ctx.signal);
  if (ctx.signal.aborted)
    throw new GrootV2Error("GROOT_E_INTERRUPTED", "Inspection was cancelled.");

  const contradictions = [
    ...pm.contradictions,
    ...topology.contradictions,
    ...agentFiles.contradictions,
    ...(await manifestContradictions(fs, registration.manifest, units)),
  ];
  const support = assessSupport({
    packageManager: pm.fact.value,
    packageManagerConflicts: pm.contradictions.map((entry) => entry.explanation),
    conflictingSignals: pm.conflictingSignals,
    lockfiles: pm.lockfiles,
    topology: topology.topology.value,
    units,
    unitProblems: [...new Set([...problems, ...analyses.flatMap((analysis) => analysis.problems)])],
    nativeMarkers: markers,
  });
  const unknowns = [
    ...topology.notes,
    ...analyses.flatMap((analysis) => analysis.notes),
    ...(await rootEnvNote(fs, topology)),
    ...fs.notes(),
  ];
  const capabilities = observeCapabilities(
    analyses.flatMap(({ unit, manifest, fingerprint }) =>
      manifest === null
        ? []
        : [
            {
              unit: unit.path,
              manifest,
              fingerprint,
              declared: { ...unit.devDependencies, ...unit.dependencies },
            },
          ],
    ),
    fact,
  );
  ctx.events.emit({
    type: "discovery.done",
    level: "debug",
    message: `found ${units.length} unit(s)`,
  });
  return validated({
    $schema: schemaUrl("project"),
    schemaVersion: 1,
    kind: "groot.project",
    root: location.root,
    observedAt,
    grootVersion: ctx.grootVersion,
    git,
    registration: registration.registration,
    name: nameFact(fact, location.root, rootManifest),
    packageManager: pm.fact,
    topology: topology.topology,
    workspaces: topology.workspaces,
    units,
    toolchains,
    agentFiles: agentFiles.files,
    capabilities,
    support,
    unknowns: [...new Set(unknowns)].sort(),
    contradictions: [...contradictions].sort((a, b) =>
      `${a.topic}\0${a.explanation}`.localeCompare(`${b.topic}\0${b.explanation}`),
    ),
  });
}

/** The revision identity an observation was made against (what plans record). */
export function revisionOf(observation: ProjectObservation): RevisionInfo {
  const { vcs, head, branch, dirty, worktreeFingerprint } = observation.git;
  return { vcs, head, branch, dirty, worktreeFingerprint };
}

/** Every path with uncommitted changes (staged, unstaged, untracked), sorted. */
export function dirtyPathsOf(observation: ProjectObservation): string[] {
  const { staged, unstaged, untracked } = observation.git;
  return [...new Set([...staged, ...unstaged, ...untracked])].sort();
}
