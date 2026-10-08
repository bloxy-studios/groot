/**
 * Unit-kind classification as an ordered chain of classifiers; the first
 * that recognizes the unit wins, so the order encodes precedence:
 *
 *   1. a declared app framework (or, for non-config packages, a backend one)
 *   2. a shared config preset name (`*-config`)
 *   3. a Supabase project directory (supabase/config.toml)
 *   4. a directory named `backend`
 *   5. library fields — exports (high), main/module/types/bin (medium)
 *   6. a framework-less entry that starts a server → api (source scan)
 *
 * Anything else is `unknown` with low confidence — reported, never guessed.
 */
import { basename } from "node:path";
import type { Confidence, UnitKind } from "../contracts/common.ts";
import type { FrameworkRef } from "../contracts/project.ts";
import type { FactFactory, ObservedFact } from "./facts.ts";
import {
  APP_FRAMEWORKS,
  BACKEND_FRAMEWORKS,
  type FrameworkRule,
  isConfigPackage,
  matchFramework,
} from "./frameworks.ts";
import { joinProjectPath, type ProjectFs } from "./fs.ts";
import { declaredPackages, type EntrySource, type UnitManifest } from "./package-fields.ts";
import { startsServer } from "./scripts.ts";

export interface KindFinding {
  readonly kind: ObservedFact<UnitKind>;
  readonly framework: ObservedFact<FrameworkRef | null>;
  /** The matched framework rule (runtime inference uses it). */
  readonly rule: FrameworkRule | null;
}

interface KindInput {
  readonly fs: ProjectFs;
  readonly fact: FactFactory;
  readonly unitPath: string;
  readonly manifest: UnitManifest;
  readonly entry: EntrySource | null;
  readonly deps: Readonly<Record<string, string>>;
  /** A kind fact sourced from the manifest. */
  readonly fromManifest: (
    kind: UnitKind,
    confidence: Confidence,
    why: string,
  ) => ObservedFact<UnitKind>;
  readonly noFramework: ObservedFact<FrameworkRef | null>;
}

type Classifier = (input: KindInput) => Promise<KindFinding | null> | KindFinding | null;

const byFramework: Classifier = ({ fact, unitPath, manifest, deps, fromManifest }) => {
  const match =
    matchFramework(APP_FRAMEWORKS, deps) ??
    (isConfigPackage(manifest.fields.name, unitPath)
      ? null
      : matchFramework(BACKEND_FRAMEWORKS, deps));
  if (match === null) return null;
  const why = `depends on ${match.evidence}`;
  return {
    kind: fromManifest(match.rule.kind, "high", why),
    framework: fact<FrameworkRef | null>({
      value: { id: match.rule.id, version: match.version },
      source: `${manifest.path} (${why})`,
      method: "manifest",
      confidence: "high",
      fingerprint: manifest.sha256,
    }),
    rule: match.rule,
  };
};

const byConfigName: Classifier = ({ unitPath, manifest, fromManifest, noFramework }) =>
  isConfigPackage(manifest.fields.name, unitPath)
    ? {
        kind: fromManifest("config", "high", "shared config preset name"),
        framework: noFramework,
        rule: null,
      }
    : null;

/** A Supabase project directory without the CLI declared as a dependency. */
const bySupabaseConfig: Classifier = async ({ fs, fact, unitPath }) => {
  const config = joinProjectPath(unitPath, "supabase/config.toml");
  if (!(await fs.isFile(config))) return null;
  const base = {
    source: config,
    method: "filesystem" as const,
    confidence: "high" as const,
    fingerprint: await fs.hash(config),
  };
  return {
    kind: fact<UnitKind>({ ...base, value: "backend" }),
    framework: fact<FrameworkRef | null>({ ...base, value: { id: "supabase", version: null } }),
    rule: BACKEND_FRAMEWORKS.find((entry) => entry.id === "supabase") ?? null,
  };
};

const byBackendDirectory: Classifier = ({ fact, unitPath, noFramework }) =>
  basename(unitPath) === "backend"
    ? {
        kind: fact<UnitKind>({
          value: "backend",
          source: `${unitPath} (directory named backend)`,
          method: "filesystem",
          confidence: "medium",
        }),
        framework: noFramework,
        rule: null,
      }
    : null;

/** exports → certainly a package for others; main/module/types/bin → probably. */
const byLibraryFields: Classifier = ({ manifest, fromManifest, noFramework }) => {
  const { fields } = manifest;
  if (fields.hasExports) {
    return {
      kind: fromManifest("library", "high", "declares exports without an app framework"),
      framework: noFramework,
      rule: null,
    };
  }
  const declaresPackageFields =
    fields.hasBin || [fields.main, fields.module, fields.types].some((value) => value !== null);
  return declaresPackageFields
    ? {
        kind: fromManifest(
          "library",
          "medium",
          "declares main/module/types/bin without an app framework",
        ),
        framework: noFramework,
        rule: null,
      }
    : null;
};

/** A framework-less entry that starts a server (Bun.serve, listen, default-export fetch). */
const byServerEntry: Classifier = ({ fact, entry, noFramework }) =>
  entry !== null && startsServer(entry.file.text)
    ? {
        kind: fact<UnitKind>({
          value: "api",
          source: `${entry.path} (starts a server)`,
          method: "source-scan",
          confidence: "medium",
          fingerprint: entry.file.sha256,
        }),
        framework: noFramework,
        rule: null,
      }
    : null;

const CLASSIFIERS: readonly Classifier[] = [
  byFramework,
  byConfigName,
  bySupabaseConfig,
  byBackendDirectory,
  byLibraryFields,
  byServerEntry,
];

/** Classify a unit; falls back to `unknown` (low confidence) when nothing recognizes it. */
export async function detectKind(
  context: { readonly fs: ProjectFs; readonly fact: FactFactory },
  unitPath: string,
  manifest: UnitManifest,
  entry: EntrySource | null,
): Promise<KindFinding> {
  const { fs, fact } = context;
  const fromManifest = (kind: UnitKind, confidence: Confidence, why: string) =>
    fact<UnitKind>({
      value: kind,
      source: `${manifest.path} (${why})`,
      method: "manifest",
      confidence,
      fingerprint: manifest.sha256,
    });
  const noFramework = fact<FrameworkRef | null>({
    value: null,
    source: `${manifest.path} (no known framework dependency)`,
    method: "manifest",
    confidence: "medium",
    fingerprint: manifest.sha256,
  });
  const input: KindInput = {
    fs,
    fact,
    unitPath,
    manifest,
    entry,
    deps: declaredPackages(manifest.fields),
    fromManifest,
    noFramework,
  };
  for (const classify of CLASSIFIERS) {
    const found = await classify(input);
    if (found !== null) return found;
  }
  return {
    kind: fromManifest("unknown", "low", "no framework, exports, main, bin, or server entry"),
    framework: noFramework,
    rule: null,
  };
}
