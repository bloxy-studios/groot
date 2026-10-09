/**
 * Per-unit analysis: one app, package, or service directory → a ProjectUnit
 * whose every inference is a fact with provenance.
 *
 * - kind/framework: kind.ts (declared frameworks first, then presets,
 *   backends, library fields, and finally a server-starting entry).
 * - runtime: `--bun` opt-in; node-only framework tooling; scripts running
 *   source files with bun vs node/tsx; @types/bun; else the package manager
 *   default (low confidence, method "default").
 * - entry: the file the dev/start scripts run, then module/main, then the
 *   conventional server entries — always relative to the unit directory and
 *   only when the file exists inside the project.
 * - ports, most likely the app's first: the commands that run the app (high;
 *   medium when the scripts run the entry and another command declares the
 *   port, ranked after the entry's), the entry source (medium), then ports
 *   tools declare for themselves — a database studio, storybook, a preview
 *   server, wherever they are started (low).
 */
import type { Confidence, PackageManager, Sha256 } from "../contracts/common.ts";
import type { ProjectUnit } from "../contracts/project.ts";
import { envFindings } from "./env-files.ts";
import type { FactFactory, ObservedFact } from "./facts.ts";
import type { FrameworkRule } from "./frameworks.ts";
import { joinProjectPath, type ProjectFs, SKIPPED_DIRS } from "./fs.ts";
import { detectKind } from "./kind.ts";
import {
  declaredPackages,
  type EntrySource,
  packageFields,
  type UnitManifest,
} from "./package-fields.ts";
import {
  entryCandidates,
  normalizeSourcePath,
  runtimeSignals,
  type ScriptPort,
  scriptPorts,
  sourcePorts,
} from "./scripts.ts";

export interface UnitContext {
  readonly fs: ProjectFs;
  readonly fact: FactFactory;
  readonly packageManager: PackageManager;
}

export interface UnitAnalysis {
  readonly unit: ProjectUnit;
  /** Project path of the unit's manifest (null for native units). */
  readonly manifest: string | null;
  readonly fingerprint: Sha256 | null;
  /** Toolchains the unit needs beyond bun/node/git. */
  readonly toolchains: readonly string[];
  /** Reasons Groot cannot certify writes to this unit (empty = none). */
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

const CONVENTIONAL_ENTRIES = [
  "src/index.ts",
  "src/server.ts",
  "src/main.ts",
  "server.ts",
  "index.ts",
  "src/app.ts",
];
const MAX_SOURCE_BYTES = 512 * 1024;
const TS_FILE = /\.[cm]?tsx?$/;

/** Accept an entry only outside generated output (dist/, build/, …). */
function usableEntry(file: string | null): string | null {
  if (file === null) return null;
  return file.split("/").some((segment) => SKIPPED_DIRS.has(segment)) ? null : file;
}

async function resolveEntry(
  ctx: UnitContext,
  unitPath: string,
  manifest: UnitManifest,
  notes: string[],
): Promise<ObservedFact<string | null>> {
  const { fs, fact } = ctx;
  for (const candidate of entryCandidates(manifest.fields.scripts)) {
    const file = usableEntry(candidate.file);
    if (file === null) continue; // generated output (dist/, build/) is not a source entry
    if (await fs.isFile(joinProjectPath(unitPath, file))) {
      return fact({
        value: file,
        source: `${manifest.path}#scripts.${candidate.script}`,
        method: "manifest",
        confidence: "high",
        fingerprint: manifest.sha256,
      });
    }
    notes.push(
      `${manifest.path} script "${candidate.script}" runs ${file}, which does not exist in ${unitPath}`,
    );
  }
  for (const field of ["module", "main"] as const) {
    const file = usableEntry(normalizeSourcePath(manifest.fields[field] ?? ""));
    if (file !== null && (await fs.isFile(joinProjectPath(unitPath, file)))) {
      return fact({
        value: file,
        source: `${manifest.path}#${field}`,
        method: "manifest",
        confidence: "medium",
        fingerprint: manifest.sha256,
      });
    }
  }
  for (const file of CONVENTIONAL_ENTRIES) {
    const source = joinProjectPath(unitPath, file);
    const hash = await fs.hash(source);
    if (hash !== null) {
      return fact({
        value: file,
        source,
        method: "filesystem",
        confidence: "low",
        fingerprint: hash,
      });
    }
  }
  return fact({
    value: null,
    source: `${manifest.path} (no dev/start script entry, module/main, or conventional entry file)`,
    method: "filesystem",
    confidence: "low",
  });
}

function detectRuntime(
  ctx: UnitContext,
  manifest: UnitManifest,
  rule: FrameworkRule | null,
): ObservedFact<ProjectUnit["runtime"]["value"]> {
  const signals = runtimeSignals(manifest.fields.scripts);
  const deps = declaredPackages(manifest.fields);
  const scripted = (value: "bun" | "node", confidence: Confidence, why: string) =>
    ctx.fact({
      value,
      source: `${manifest.path} (${why})`,
      method: "manifest",
      confidence,
      fingerprint: manifest.sha256,
    });
  if (signals.bunFlag) return scripted("bun", "high", "scripts opt into Bun with --bun");
  if (rule?.runtime === "node") {
    return scripted("node", "high", `${rule.id} tooling runs on Node.js`);
  }
  if (signals.bunFile && !signals.nodeFile) {
    return scripted("bun", "high", "scripts run source files with bun");
  }
  if (signals.nodeFile && !signals.bunFile) {
    return scripted("node", "high", "scripts run source files with node/tsx");
  }
  if ("@types/bun" in deps || "bun-types" in deps) {
    return scripted("bun", "medium", "declares @types/bun");
  }
  if (signals.bunFile && signals.nodeFile) {
    const runner = entryCandidates(manifest.fields.scripts)[0]?.runner;
    const value = runner === "bun" ? "bun" : "node";
    return scripted(value, "medium", "the dev/start script's runner (scripts use both)");
  }
  const pm = ctx.packageManager;
  return ctx.fact({
    value: pm === "bun" || pm === "unknown" ? "bun" : "node",
    source: `package manager ${pm} (no runtime-specific signal in ${manifest.path})`,
    method: "default",
    confidence: "low",
  });
}

async function detectLanguage(
  fs: ProjectFs,
  unitPath: string,
  manifest: UnitManifest,
  entry: string | null,
): Promise<"typescript" | "javascript"> {
  const { fields } = manifest;
  if ("typescript" in declaredPackages(fields)) return "typescript";
  if (entry !== null && TS_FILE.test(entry)) return "typescript";
  if ([fields.main, fields.module].some((value) => value !== null && TS_FILE.test(value))) {
    return "typescript";
  }
  const hasTsconfig = await fs.isFile(joinProjectPath(unitPath, "tsconfig.json"));
  return hasTsconfig ? "typescript" : "javascript";
}

/**
 * Ports, most likely the app's first. When the scripts run the detected entry,
 * a port another of the app's commands declares — a framework CLI, or a
 * sidecar the dev script also starts — is medium and ranks after the entry
 * source's own ports: the entry is the app, and states its port.
 */
function unitPorts(
  ctx: UnitContext,
  manifest: UnitManifest,
  entry: string | null,
  entrySource: EntrySource | null,
): ObservedFact<number>[] {
  const { scripts } = manifest.fields;
  const declared = scriptPorts(scripts);
  // The entry the scripts run (null when they run no detected entry).
  const ran = entryCandidates(scripts).some((c) => c.file === entry) ? entry : null;
  const besideEntry = (port: ScriptPort): boolean => ran !== null && !port.runs.includes(ran);
  const ports: ObservedFact<number>[] = [];
  const add = (port: ObservedFact<number>): void => {
    if (!ports.some((existing) => existing.value === port.value)) ports.push(port);
  };
  const fromScripts = (found: readonly ScriptPort[], confidence: Confidence): void => {
    for (const { port, script } of found) {
      add(
        ctx.fact({
          value: port,
          source: `${manifest.path}#scripts.${script}`,
          method: "manifest",
          confidence,
          fingerprint: manifest.sha256,
        }),
      );
    }
  };
  const app = declared.filter((port) => port.app);
  fromScripts(
    app.filter((port) => !besideEntry(port)),
    "high",
  );
  if (entrySource !== null) {
    for (const port of sourcePorts(entrySource.file.text)) {
      add(
        ctx.fact({
          value: port,
          source: entrySource.path,
          method: "source-scan",
          confidence: "medium",
          fingerprint: entrySource.file.sha256,
        }),
      );
    }
  }
  fromScripts(app.filter(besideEntry), "medium");
  fromScripts(
    declared.filter((port) => !port.app),
    "low",
  );
  return ports;
}

const COMPOSE_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/** Native toolchains a unit directory needs (beyond bun/node/git). */
export async function toolchainNeeds(
  fs: ProjectFs,
  unitPath: string,
  frameworkId: string | null,
): Promise<string[]> {
  const file = (name: string) => fs.isFile(joinProjectPath(unitPath, name));
  const dir = (name: string) => fs.isDir(joinProjectPath(unitPath, name));
  const checks: ReadonlyArray<readonly [string, () => Promise<boolean>]> = [
    [
      "cargo",
      async () =>
        frameworkId === "tauri" ||
        (await file("Cargo.toml")) ||
        (await file("src-tauri/Cargo.toml")),
    ],
    ["xcodebuild", async () => (await dir("ios")) || (await file("Package.swift"))],
    ["pod", () => file("ios/Podfile")],
    ["java", () => dir("android")],
    ["python3", () => fs.anyFile(unitPath, ["pyproject.toml", "requirements.txt", "setup.py"])],
    ["go", () => file("go.mod")],
    ["flutter", () => file("pubspec.yaml")],
    [
      "docker",
      async () => frameworkId === "supabase" || (await fs.anyFile(unitPath, COMPOSE_FILES)),
    ],
  ];
  const needs: string[] = [];
  for (const [id, check] of checks) if (await check()) needs.push(id);
  return needs;
}

async function readUnitManifest(
  fs: ProjectFs,
  unitPath: string,
  problems: string[],
): Promise<UnitManifest> {
  const path = joinProjectPath(unitPath, "package.json");
  const file = await fs.readText(path);
  let value: unknown = {};
  if (file !== null) {
    try {
      value = JSON.parse(file.text);
    } catch {
      value = null;
    }
  }
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject) problems.push(`${path} is not a valid JSON object`);
  const record = isObject ? (value as Record<string, unknown>) : {};
  return { path, sha256: file?.sha256 ?? null, fields: packageFields(record) };
}

async function readEntrySource(
  fs: ProjectFs,
  unitPath: string,
  entry: string | null,
): Promise<EntrySource | null> {
  if (entry === null) return null;
  const path = joinProjectPath(unitPath, entry);
  const file = await fs.readText(path, MAX_SOURCE_BYTES);
  return file === null ? null : { path, file };
}

/** Analyze a unit directory that has a package.json. */
export async function analyzePackageUnit(
  ctx: UnitContext,
  unitPath: string,
): Promise<UnitAnalysis> {
  const problems: string[] = [];
  const notes: string[] = [];
  const manifest = await readUnitManifest(ctx.fs, unitPath, problems);
  const entry = await resolveEntry(ctx, unitPath, manifest, notes);
  const entrySource = await readEntrySource(ctx.fs, unitPath, entry.value);
  const { kind, framework, rule } = await detectKind(ctx, unitPath, manifest, entrySource);
  const env = await envFindings(ctx.fs, unitPath);
  if (kind.value === "unknown") {
    notes.push(`${unitPath}: kind could not be determined (${kind.source})`);
  }
  return {
    unit: {
      id: unitPath,
      path: unitPath,
      packageName: manifest.fields.name,
      kind,
      framework,
      runtime: detectRuntime(ctx, manifest, rule),
      language: await detectLanguage(ctx.fs, unitPath, manifest, entry.value),
      entry,
      scripts: manifest.fields.scripts,
      dependencies: manifest.fields.dependencies,
      devDependencies: manifest.fields.devDependencies,
      ports: unitPorts(ctx, manifest, entry.value, entrySource),
      envFiles: env.files,
      envVariables: env.variables,
    },
    manifest: manifest.path,
    fingerprint: manifest.sha256,
    toolchains: await toolchainNeeds(ctx.fs, unitPath, framework.value?.id ?? null),
    problems,
    notes,
  };
}
