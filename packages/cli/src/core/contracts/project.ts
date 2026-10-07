/**
 * Project contract — the OBSERVED state of a repository, produced by
 * read-only discovery (`groot inspect`). Every inferred value is a Fact with
 * provenance, confidence, and freshness; facts never silently override the
 * blueprint (desired state) — contradictions are reported, not merged.
 */
import { z } from "zod";
import {
  Confidence,
  fact,
  IsoDate,
  PackageManager,
  RelPath,
  RevisionInfo,
  Sha256,
  Topology,
  UnitKind,
  UnitPath,
} from "./common.ts";

export const FrameworkRef = z
  .object({
    id: z.string(),
    /** Declared version range from the manifest (exact resolution lives in the lockfile). */
    version: z.string().nullable(),
  })
  .strict();
export type FrameworkRef = z.infer<typeof FrameworkRef>;

export const EnvVariableObservation = z
  .object({
    name: z.string(),
    file: RelPath,
    /** Name carries a client-exposure prefix (NEXT_PUBLIC_, VITE_, …). */
    publicPrefix: z.boolean(),
  })
  .strict();

/** One app, package, or service inside the project. */
export const ProjectUnit = z
  .object({
    /** Stable identifier: the unit path ("apps/api") or "." for a root single app. */
    id: z.string(),
    path: UnitPath,
    packageName: z.string().nullable(),
    kind: fact(UnitKind),
    framework: fact(FrameworkRef.nullable()),
    runtime: fact(z.enum(["bun", "node", "native", "unknown"])),
    language: z.enum(["typescript", "javascript", "unknown"]),
    /** Server/app entry file, when it can be determined statically. */
    entry: fact(RelPath.nullable()),
    scripts: z.record(z.string(), z.string()),
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
    ports: z.array(fact(z.number().int().min(1).max(65535))),
    envFiles: z.array(RelPath),
    /** Variable NAMES only — discovery never reads or reports values. */
    envVariables: z.array(EnvVariableObservation),
  })
  .strict();
export type ProjectUnit = z.infer<typeof ProjectUnit>;

export const Toolchain = z
  .object({
    id: z.string(),
    available: z.boolean(),
    version: z.string().nullable(),
    /** Units (or "groot") that need it. */
    requiredBy: z.array(z.string()),
    source: z.string(),
  })
  .strict();
export type Toolchain = z.infer<typeof Toolchain>;

export const ManagedRegionState = z
  .object({
    id: z.string(),
    /** Content hash recorded in the region's begin marker. */
    recordedHash: Sha256.nullable(),
    actualHash: Sha256,
    /** false when a human edited inside the managed region. */
    intact: z.boolean(),
  })
  .strict();

export const AgentFile = z
  .object({
    path: RelPath,
    tool: z.enum([
      "agents-md",
      "claude-md",
      "claude-local-md",
      "claude-skill",
      "codex-skill",
      "agent-skill",
      "cursor-rules",
      "copilot-instructions",
      "mcp-config",
    ]),
    bytes: z.number().int().nonnegative(),
    sha256: Sha256,
    managedRegions: z.array(ManagedRegionState),
  })
  .strict();
export type AgentFile = z.infer<typeof AgentFile>;

export const CapabilityObservation = z
  .object({
    capability: z.string(),
    provider: z.string(),
    unit: UnitPath,
    evidence: z.string(),
  })
  .strict();

export const Contradiction = z
  .object({
    topic: z.string(),
    explanation: z.string(),
    sources: z.array(z.string()),
  })
  .strict();

export const Registration = z
  .object({
    status: z.enum(["unregistered", "v1", "v2", "invalid", "unsupported-version"]),
    manifestPath: RelPath.nullable(),
    version: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type Registration = z.infer<typeof Registration>;

export const WritableSupport = z
  .object({
    /** certified: Groot may write here · inspect-only: facts only · unsupported. */
    level: z.enum(["certified", "inspect-only", "unsupported"]),
    reasons: z.array(z.string()),
    /** Actionable path toward support when not certified. */
    nextStep: z.string().nullable(),
  })
  .strict();

export const GitState = RevisionInfo.extend({
  staged: z.array(RelPath),
  unstaged: z.array(RelPath),
  untracked: z.array(RelPath),
}).strict();
export type GitState = z.infer<typeof GitState>;

export const ProjectObservation = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.project"),
    root: z.string(),
    observedAt: IsoDate,
    grootVersion: z.string(),
    git: GitState,
    registration: Registration,
    name: fact(z.string().nullable()),
    packageManager: fact(PackageManager),
    topology: fact(z.union([Topology, z.literal("unknown")])),
    workspaces: fact(z.array(z.string())),
    units: z.array(ProjectUnit),
    toolchains: z.array(Toolchain),
    agentFiles: z.array(AgentFile),
    capabilities: z.array(fact(CapabilityObservation)),
    support: WritableSupport,
    unknowns: z.array(z.string()),
    contradictions: z.array(Contradiction),
  })
  .strict();
export type ProjectObservation = z.infer<typeof ProjectObservation>;

export { Confidence };
