/**
 * Shared primitives for every Groot v2 contract (docs/v2-architecture.md#contracts).
 *
 * The zod schemas in core/contracts/ are the single source of truth: they
 * validate untrusted input at every boundary (plan files, groot.json, task
 * files, MCP arguments), give the TypeScript types via z.infer, and generate
 * the published JSON Schemas under schemas/v2/ (scripts/generate-schemas.ts —
 * a test fails when the checked-in files drift).
 */
import { z } from "zod";

/** Base URL of the published v2 JSON Schemas (one file per contract). */
export const SCHEMA_BASE_URL =
  "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/v2";

/** Published schema URL for a contract name ("plan" → …/schemas/v2/plan.schema.json). */
export function schemaUrl(name: string): string {
  return `${SCHEMA_BASE_URL}/${name}.schema.json`;
}

/** ISO-8601 timestamp with offset (Groot always writes UTC `Z`). */
export const IsoDate = z.iso.datetime({ offset: true });

/** Content fingerprint: `sha256:<64 hex>`. */
export const Sha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>");
export type Sha256 = z.infer<typeof Sha256>;

/** One path segment: non-empty, not `..`, no separators or control characters. */
const PATH_SEGMENT = String.raw`(?!\.\.(?:/|$))[^/\\\x00-\x1f\x7f]+`;

/**
 * Project-relative POSIX path, validated segment by segment. Never absolute,
 * never escaping the project (`..` segments), no empty segments, backslashes,
 * or control characters. Runtime path resolution additionally enforces
 * symlink containment (core/fs/paths.ts).
 */
export const RelPath = z
  .string()
  .min(1)
  .regex(
    new RegExp(`^(?![A-Za-z]:)${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`),
    "expected a project-relative POSIX path (no leading /, no empty or .. segments, no backslashes or control characters)",
  );
export type RelPath = z.infer<typeof RelPath>;

/** A project-relative path, or "." for the project root (single-app units). */
export const UnitPath = z.union([z.literal("."), RelPath]);
export type UnitPath = z.infer<typeof UnitPath>;

const idPattern = (prefix: string) => new RegExp(`^${prefix}_[0-9a-z]{8,40}$`);

export const PlanId = z.string().regex(idPattern("plan"));
export const OperationId = z.string().regex(idPattern("op"));
export const EvidenceId = z.string().regex(idPattern("ev"));
export const TaskId = z.string().regex(idPattern("task"));
export const DecisionId = z.string().regex(idPattern("dec"));
export const ReviewId = z.string().regex(idPattern("rev"));

export const Confidence = z.enum(["certain", "high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/** How a fact was obtained — discovery never executes repository configuration. */
export const FactMethod = z.enum([
  "manifest",
  "lockfile",
  "filesystem",
  "source-scan",
  "command",
  "human",
  "default",
]);
export type FactMethod = z.infer<typeof FactMethod>;

/**
 * An observed fact with provenance (source + method), confidence, and
 * freshness (observedAt + the fingerprint of the source at observation time,
 * so a later change to the source invalidates the fact).
 */
export function fact<T extends z.ZodType>(value: T) {
  return z
    .object({
      value,
      source: z.string(),
      method: FactMethod,
      confidence: Confidence,
      observedAt: IsoDate,
      fingerprint: Sha256.nullable(),
    })
    .strict();
}

export interface Fact<T> {
  readonly value: T;
  readonly source: string;
  readonly method: FactMethod;
  readonly confidence: Confidence;
  readonly observedAt: string;
  readonly fingerprint: Sha256 | null;
}

/** The repository revision a result was produced against. */
export const RevisionInfo = z
  .object({
    vcs: z.enum(["git", "none"]),
    head: z.string().nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean(),
    /**
     * Fingerprint of uncommitted state (tracked diff + untracked file hashes),
     * so evidence from a dirty tree is tied to the exact content checked.
     * null when the tree is clean or not a git repository.
     */
    worktreeFingerprint: Sha256.nullable(),
  })
  .strict();
export type RevisionInfo = z.infer<typeof RevisionInfo>;

/** Where a check ran. */
export const EnvironmentInfo = z
  .object({
    os: z.string(),
    arch: z.string(),
    bun: z.string(),
    groot: z.string(),
    ci: z.boolean(),
  })
  .strict();
export type EnvironmentInfo = z.infer<typeof EnvironmentInfo>;

/** Classes of side effects. Plans declare them; policy permits or denies them. */
export const ActionClass = z.enum([
  "fs.create",
  "fs.edit",
  "fs.delete",
  "fs.move",
  "deps.change",
  "install",
  "generator",
  "command",
  "network",
  "git",
  "process",
  "external",
]);
export type ActionClass = z.infer<typeof ActionClass>;

/** Kinds of project units (apps, packages, services). */
export const UnitKind = z.enum([
  "web",
  "mobile",
  "desktop",
  "api",
  "backend",
  "library",
  "config",
  "unknown",
]);
export type UnitKind = z.infer<typeof UnitKind>;

export const Topology = z.enum(["single", "monorepo"]);
export type Topology = z.infer<typeof Topology>;

export const PackageManager = z.enum(["bun", "npm", "pnpm", "yarn", "unknown"]);
export type PackageManager = z.infer<typeof PackageManager>;

/**
 * Environment-variable contract: who consumes a variable, whether it is a
 * server secret or public configuration, and where its value safely lives.
 * Values never appear in contracts, plans, context, or evidence — names only.
 */
export const EnvVarContract = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** Unit path of the consumer ("apps/api" or "."). */
    consumer: UnitPath,
    /** server: read only by server code · public: shipped to clients · build: build-time only. */
    scope: z.enum(["server", "public", "build"]),
    /** secret: must never reach clients, context, logs, or committed files. */
    sensitivity: z.enum(["secret", "config"]),
    required: z.boolean(),
    description: z.string(),
    /** The file the consumer's framework actually loads (gitignored for secrets). */
    storage: RelPath,
    /** Placeholder written to examples — never a real secret. */
    example: z.string(),
    /** Groot may generate a local development value. */
    generate: z.enum(["random-secret", "local-url", "none"]),
    /** Recipe or adapter that declared the contract. */
    declaredBy: z.string(),
  })
  .strict();
export type EnvVarContract = z.infer<typeof EnvVarContract>;

/** Client-exposure prefixes per framework convention — secrets must never use them. */
export const PUBLIC_ENV_PREFIXES: readonly string[] = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
  "REACT_APP_",
  "GATSBY_",
];

/** A verification obligation a plan, recipe, or blueprint declares. */
export const VerificationProfile = z.enum(["structural", "build", "runtime", "product-flow"]);
export type VerificationProfile = z.infer<typeof VerificationProfile>;

export const VerificationContract = z
  .object({
    id: z.string().min(1),
    profile: VerificationProfile,
    description: z.string(),
    /** Registered checker that implements it (core/verify). */
    checker: z.string(),
    capability: z.string().nullable(),
    unit: UnitPath.nullable(),
    /** What running it needs — used for skipped/blocked reporting and policy. */
    needs: z
      .object({
        network: z.boolean(),
        processes: z.boolean(),
        credentials: z.array(z.string()),
        toolchains: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type VerificationContract = z.infer<typeof VerificationContract>;

/** Decision with explicit authority — human confirmation outranks inference. */
export const Decision = z
  .object({
    id: DecisionId,
    topic: z.string(),
    value: z.string(),
    authority: z.enum(["human", "default", "recipe", "inferred"]),
    rationale: z.string(),
    source: z.string(),
    at: IsoDate,
  })
  .strict();
export type Decision = z.infer<typeof Decision>;
