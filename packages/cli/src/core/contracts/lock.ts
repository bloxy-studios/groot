/**
 * Lock contract — groot.lock.json, the exact resolution of every generator and
 * recipe an operation used, plus the artifacts Groot owns. Committed next to
 * groot.json so ownership and replay information travel with the repository;
 * transitive package integrity stays in bun.lock.
 */
import { z } from "zod";
import { IsoDate, PlanId, RelPath, Sha256, UnitPath } from "./common.ts";

export const LOCK_VERSION = 1 as const;

/** One exact generator resolution (`create-next-app@16` → 16.0.7 + integrity). */
export const GeneratorLock = z
  .object({
    package: z.string(),
    /** The series Groot's adapter pins ("16", "0.19"). */
    range: z.string(),
    /** Exact version resolved from the registry, or null when unresolved (offline). */
    version: z.string().nullable(),
    /** Registry dist.integrity (SRI sha512), when available. */
    integrity: z.string().nullable(),
    tarball: z.string().nullable(),
    resolvedAt: IsoDate,
    source: z.enum(["npm-registry", "unresolved"]),
    usedBy: z.array(UnitPath),
  })
  .strict();
export type GeneratorLock = z.infer<typeof GeneratorLock>;

/**
 * A file Groot owns (fully, a managed region inside it, or specific keys of a
 * structured file). The hash is the content right after Groot wrote it — a
 * later mismatch means a human changed it, which upgrades/rollback respect.
 */
export const OwnedArtifact = z
  .object({
    path: RelPath,
    ownership: z.enum(["file", "region", "keys"]),
    /** Region id or JSON pointers for partial ownership. */
    parts: z.array(z.string()),
    sha256: Sha256,
  })
  .strict();
export type OwnedArtifact = z.infer<typeof OwnedArtifact>;

export const RecipeLock = z
  .object({
    capability: z.string(),
    recipe: z.string(),
    recipeVersion: z.string(),
    /** BlueprintApp id the recipe was applied to. */
    target: z.string(),
    /** The plan that applied it (1:1 with its operation). */
    appliedBy: PlanId,
    plannedAt: IsoDate,
    /** Exact dependency versions the recipe added (package → version). */
    dependencies: z.record(z.string(), z.string()),
    artifacts: z.array(OwnedArtifact),
  })
  .strict();
export type RecipeLock = z.infer<typeof RecipeLock>;

export const GrootLock = z
  .object({
    $schema: z.string(),
    lockVersion: z.literal(LOCK_VERSION),
    generatedBy: z.string(),
    generators: z.array(GeneratorLock),
    recipes: z.array(RecipeLock),
    /** Context-sync artifacts (managed instruction regions, skills). */
    context: z.array(OwnedArtifact),
  })
  .strict();
export type GrootLock = z.infer<typeof GrootLock>;

export const LOCK_FILE = "groot.lock.json";
export const STATE_DIR = ".groot";

export { RelPath };
