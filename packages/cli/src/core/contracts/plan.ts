/**
 * Plan contract — a concrete, previewable operation: every file write, edit,
 * move, and delete; every dependency change and command; external effects;
 * the preconditions (content fingerprints) that make the plan stale when a
 * human edits an affected file; ownership; environment contracts; required
 * verification; and the honest recovery limits.
 *
 * Plans are produced by core/planner and executed by core/executor with a
 * journal (contracts/operation.ts). `fingerprint` covers intent + actions +
 * preconditions so re-applying a completed plan is detected and becomes a
 * no-op instead of a duplicate effect.
 */
import { z } from "zod";
import { RecoveryInfo, SolverResult } from "./capability.ts";
import {
  ActionClass,
  EnvVarContract,
  IsoDate,
  PlanId,
  RelPath,
  RevisionInfo,
  Sha256,
  UnitPath,
  VerificationContract,
} from "./common.ts";
import { GeneratorLock } from "./lock.ts";

// ---------------------------------------------------------------------------
// Structured edits
// ---------------------------------------------------------------------------

/**
 * An RFC 6901 pointer ("" = the whole document). Tokens that reach prototype
 * machinery (`__proto__`, `constructor`, `prototype`) are not JSON members and
 * are refused, so an untrusted plan can never modify the process through an edit.
 */
export const JsonPointer = z
  .string()
  .regex(
    /^(?:\/(?!(?:__proto__|constructor|prototype)(?:\/|$))[^/]*)*$/,
    "expected an RFC 6901 JSON pointer without __proto__, constructor, or prototype tokens",
  );

/** JSON edit operations; pointers are RFC 6901. Formatting is preserved (indent + trailing newline). */
export const JsonOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), pointer: JsonPointer, value: z.unknown() }).strict(),
  z
    .object({
      op: z.literal("set-if-absent"),
      pointer: JsonPointer,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal("merge"),
      pointer: JsonPointer,
      value: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ op: z.literal("remove"), pointer: JsonPointer }).strict(),
  z.object({ op: z.literal("append-unique"), pointer: JsonPointer, value: z.unknown() }).strict(),
]);
export type JsonOp = z.infer<typeof JsonOp>;

export const CommentStyle = z.enum(["html", "hash", "slash"]);
export type CommentStyle = z.infer<typeof CommentStyle>;

export const StructuredEdit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), ops: z.array(JsonOp) }).strict(),
  /** Create or replace a marker-delimited region; human text outside it is preserved. */
  z
    .object({
      kind: z.literal("managed-region"),
      regionId: z.string().regex(/^[a-z0-9][a-z0-9-.]*$/),
      content: z.string(),
      commentStyle: CommentStyle,
      placement: z.enum(["start", "end"]),
    })
    .strict(),
  /** Append lines missing from the file (exact-line membership), e.g. .gitignore. */
  z
    .object({
      kind: z.literal("lines"),
      lines: z.array(z.string()),
      header: z.string().nullable(),
    })
    .strict(),
  /**
   * Insert a managed region after/before the UNIQUE match of `anchor` (a regex
   * over the source text). Zero or several matches → conflict, never a guess.
   * Re-applying replaces the region (idempotent).
   */
  z
    .object({
      kind: z.literal("source-anchor"),
      anchor: z.string(),
      anchorDescription: z.string(),
      position: z.enum(["after-line", "before-line", "end-of-file"]),
      regionId: z.string().regex(/^[a-z0-9][a-z0-9-.]*$/),
      content: z.string(),
      commentStyle: CommentStyle,
    })
    .strict(),
  /** Add missing `NAME=value` entries to a dotenv file; values are placeholders, never secrets. */
  z
    .object({
      kind: z.literal("env"),
      entries: z.array(
        z.object({ name: z.string(), value: z.string(), comment: z.string().nullable() }).strict(),
      ),
    })
    .strict(),
]);
export type StructuredEdit = z.infer<typeof StructuredEdit>;

/** Dotenv files by basename: `.env`, `.env.local`, `.env.production`, … */
const DOTENV_FILE = /^\.env(?:\..+)?$/;

/** Committed example dotenv files, which hold placeholders only. */
const DOTENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/;

/**
 * True when an edit's result may hold secret values: every `env` edit, and
 * any edit of a dotenv file other than a committed example. A plan never
 * carries such a result (`after` is null) — the executor computes it at apply
 * time — so values never enter plans or journals.
 */
export function isSecretBearingEdit(path: string, edit: StructuredEdit): boolean {
  if (edit.kind === "env") return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DOTENV_FILE.test(name) && !DOTENV_EXAMPLE.test(name);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ActionBase = {
  /** Stable within the plan ("s01"); journal records reference it. */
  id: z.string().regex(/^s\d{2,4}$/),
  description: z.string(),
  classes: z.array(ActionClass),
  reversible: z.boolean(),
  /** What rollback will actually do for this step — or why it cannot. */
  compensation: z.string(),
};

/** Expected state of a path before a write. */
export const PathExpectation = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("sha256"), sha256: Sha256 }).strict(),
  /** Computed during execution (path produced by an earlier step of this plan). */
  z.object({ state: z.literal("produced"), byStep: z.string() }).strict(),
]);
export type PathExpectation = z.infer<typeof PathExpectation>;

export const FileWriteAction = z
  .object({
    ...ActionBase,
    type: z.literal("file.write"),
    path: RelPath,
    content: z.string(),
    sha256: Sha256,
    expect: PathExpectation,
    ownership: z.enum(["file", "none"]),
    executable: z.boolean(),
  })
  .strict();

export const FileEditAction = z
  .object({
    ...ActionBase,
    type: z.literal("file.edit"),
    path: RelPath,
    edit: StructuredEdit,
    /**
     * Precomputed when the file's content is known at planning time (exact
     * preview): `expect` pins that content and `after` is the result. Null
     * (computed during execution) for files whose content an earlier step
     * changes without a preview, and for secret-bearing edits — env edits
     * and non-example dotenv files — whose `edit` is the preview instead.
     */
    expect: PathExpectation,
    after: z.object({ content: z.string(), sha256: Sha256 }).strict().nullable(),
    /** Ownership Groot claims inside the file (region id / JSON pointers). */
    owns: z.array(z.string()),
    createIfMissing: z.boolean(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.after !== null && isSecretBearingEdit(action.path, action.edit)) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message:
          "must be null for an env edit or an edit of a dotenv file (dotenv contents never enter a plan)",
      });
    }
  });

export const FileDeleteAction = z
  .object({
    ...ActionBase,
    type: z.literal("file.delete"),
    path: RelPath,
    expect: PathExpectation,
    /** Directory trees are only deleted when produced by this operation. */
    recursive: z.boolean(),
  })
  .strict();

export const FileMoveAction = z
  .object({
    ...ActionBase,
    type: z.literal("file.move"),
    from: RelPath,
    to: RelPath,
    expect: PathExpectation,
  })
  .strict();

export const DependencyChange = z
  .object({
    unit: UnitPath,
    package: z.string(),
    from: z.string().nullable(),
    to: z.string(),
    dev: z.boolean(),
  })
  .strict();
export type DependencyChange = z.infer<typeof DependencyChange>;

export const DepsAction = z
  .object({
    ...ActionBase,
    type: z.literal("deps.add"),
    unit: UnitPath,
    changes: z.array(DependencyChange),
    expect: PathExpectation,
  })
  .strict();

export const CommandAction = z
  .object({
    ...ActionBase,
    type: z.literal("command.run"),
    argv: z.array(z.string()).min(1),
    cwd: UnitPath,
    purpose: z.enum(["install", "codegen", "migrate", "git", "script", "check"]),
    network: z.boolean(),
    /** Safe to repeat — resume re-runs it rather than guessing its outcome. */
    idempotent: z.boolean(),
    timeoutMs: z.number().int().positive(),
    /** Non-secret environment for the command. */
    env: z.record(z.string(), z.string()),
    stdin: z.string().nullable(),
    /** Paths whose before/after hashes are journaled (rollback restores them). */
    touches: z.array(RelPath),
  })
  .strict();

export const GeneratorAction = z
  .object({
    ...ActionBase,
    type: z.literal("generator.run"),
    generator: GeneratorLock.pick({ package: true, range: true, version: true, integrity: true }),
    argv: z.array(z.string()).min(1),
    cwd: UnitPath,
    /**
     * staged: run in a disposable directory, inspect, then promote into
     * `produces` only when preconditions still hold. in-place: generator
     * writes directly (its output path must be absent beforehand).
     */
    mode: z.enum(["staged", "in-place"]),
    produces: UnitPath,
    stdin: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
    /** Remove a .git the generator created inside `produces`. */
    scrubGit: z.boolean(),
    /** Upstream output is not predictable byte-for-byte. */
    predictable: z.literal(false),
  })
  .strict();

/** Wraps a vetted v1 engine stage (stitch, trunk cleanup) as one journaled step. */
export const InternalAction = z
  .object({
    ...ActionBase,
    type: z.literal("internal"),
    handler: z.string(),
    args: z.record(z.string(), z.unknown()),
    touches: z.array(RelPath),
  })
  .strict();

/** Generate a local development secret into a gitignored env file. The value never enters the plan, journal, or output. */
export const SecretAction = z
  .object({
    ...ActionBase,
    type: z.literal("env.secret"),
    path: RelPath,
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    generator: z.enum(["random-secret"]),
  })
  .strict();

/** An effect on a provider account — executed only through a supporting adapter and policy. */
export const ExternalAction = z
  .object({
    ...ActionBase,
    type: z.literal("external"),
    provider: z.string(),
    effect: z.string(),
    idempotencyKey: z.string(),
    cost: z.enum(["free", "paid", "unknown"]),
  })
  .strict();

export const PlannedAction = z.discriminatedUnion("type", [
  FileWriteAction,
  FileEditAction,
  FileDeleteAction,
  FileMoveAction,
  DepsAction,
  CommandAction,
  GeneratorAction,
  InternalAction,
  SecretAction,
  ExternalAction,
]);
export type PlannedAction = z.infer<typeof PlannedAction>;
export type FileWriteAction = z.infer<typeof FileWriteAction>;
export type FileEditAction = z.infer<typeof FileEditAction>;
export type FileDeleteAction = z.infer<typeof FileDeleteAction>;
export type FileMoveAction = z.infer<typeof FileMoveAction>;
export type DepsAction = z.infer<typeof DepsAction>;
export type CommandAction = z.infer<typeof CommandAction>;
export type GeneratorAction = z.infer<typeof GeneratorAction>;
export type InternalAction = z.infer<typeof InternalAction>;
export type SecretAction = z.infer<typeof SecretAction>;
export type ExternalAction = z.infer<typeof ExternalAction>;

// ---------------------------------------------------------------------------
// Preconditions, ownership, plan
// ---------------------------------------------------------------------------

export const Precondition = z.discriminatedUnion("type", [
  /** A touched path must still be in the state the plan was computed against. */
  z
    .object({
      type: z.literal("path"),
      path: RelPath,
      expect: PathExpectation,
      /** The file had uncommitted changes at planning time (preserved, not a conflict). */
      dirty: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("manifest"),
      state: z.enum(["absent", "v1", "v2"]),
      sha256: Sha256.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolchain"),
      id: z.string(),
      minVersion: z.string().nullable(),
      reason: z.string(),
    })
    .strict(),
  /** The target directory must be absent or empty (fresh creation). */
  z.object({ type: z.literal("fresh-dir"), path: UnitPath }).strict(),
]);
export type Precondition = z.infer<typeof Precondition>;

export const OwnershipRule = z
  .object({
    path: RelPath,
    owner: z.enum(["groot", "shared", "human"]),
    parts: z.array(z.string()),
    note: z.string(),
  })
  .strict();
export type OwnershipRule = z.infer<typeof OwnershipRule>;

export const PlanIntent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("init"),
      name: z.string(),
      topology: z.enum(["single", "monorepo"]),
      selections: z.record(z.string(), z.string()),
      capabilities: z.array(z.string()),
    })
    .strict(),
  z.object({ type: z.literal("adopt") }).strict(),
  z.object({ type: z.literal("migrate"), from: z.literal(1), to: z.literal(2) }).strict(),
  z
    .object({
      type: z.literal("add-capability"),
      capabilities: z.array(z.string()),
      target: z.string().nullable(),
      recipe: z.string().nullable(),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    })
    .strict(),
  z.object({ type: z.literal("context-sync") }).strict(),
]);
export type PlanIntent = z.infer<typeof PlanIntent>;

export const OperationPlan = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.plan"),
    planId: PlanId,
    createdAt: IsoDate,
    createdWith: z.string(),
    intent: PlanIntent,
    summary: z.string(),
    project: z
      .object({
        /** Absolute root at planning time; apply refuses a different root. */
        root: z.string(),
        topology: z.enum(["single", "monorepo"]),
        revision: RevisionInfo,
      })
      .strict(),
    capabilities: SolverResult,
    generators: z.array(GeneratorLock),
    actions: z.array(PlannedAction),
    dependencies: z.array(DependencyChange),
    environment: z.array(EnvVarContract),
    external: z.array(ExternalAction),
    preconditions: z.array(Precondition),
    ownership: z.array(OwnershipRule),
    /** Every action class the plan needs; policy must allow all of them. */
    requiredClasses: z.array(ActionClass),
    verification: z.array(VerificationContract),
    recovery: RecoveryInfo,
    /** Explicit assumptions and unpredictable parts (e.g. upstream generator output). */
    assumptions: z.array(z.string()),
    /** sha256 over intent + actions + preconditions (canonical JSON). */
    fingerprint: Sha256,
  })
  .strict();
export type OperationPlan = z.infer<typeof OperationPlan>;
