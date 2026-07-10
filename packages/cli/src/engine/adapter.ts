/**
 * The adapter contract (docs/architecture.md#adapter-contract): every scaffold is
 * described by one adapter. Generator invocations must be fully non-interactive and
 * must not git-init, install, or write outside their target directory — the exact
 * flags per generator are normative in docs/scaffold-flows.md.
 */
import type { FrameworkId, Plan, PlannedScaffold, Slot } from "./types.ts";

/** A single external command the generate stage runs. */
export interface GeneratorCommand {
  /** argv for Bun.spawn — argv[0] is the executable (typically "bunx"). */
  readonly argv: readonly string[];
  /** Working directory for the spawn. */
  readonly cwd: string;
  /** Human label for progress output ("Growing apps/web (Next.js)…"). */
  readonly label: string;
  /**
   * Text piped to the generator's stdin, for prompts that have no CLI flag
   * (e.g. create-hono's install confirmation). Omit for stdin-less generators.
   */
  readonly stdin?: string;
}

/** A file groot writes itself (direct-write scaffolds and small overlays). */
export interface FileSpec {
  /** Path relative to the workspace root. */
  readonly path: string;
  readonly contents: string;
}

/** Everything an adapter may need to compute its commands and files. */
export interface AdapterContext {
  readonly plan: Plan;
  readonly scaffold: PlannedScaffold;
}

/**
 * One scaffold adapter. `patches()` — the stitch-stage transforms — joins this
 * contract in the next PR of the engine series (see docs/roadmap.md v0.2).
 */
export interface ScaffoldAdapter {
  readonly id: FrameworkId;
  readonly slot: Slot;
  /** The generator invocation, or null when groot writes the files directly. */
  command(ctx: AdapterContext): GeneratorCommand | null;
  /** Files groot writes itself, relative to the workspace root. */
  writeFiles?(ctx: AdapterContext): FileSpec[];
  /** Commands run after this scaffold's files exist (e.g. `convex codegen --init`). */
  postCommands?(ctx: AdapterContext): GeneratorCommand[];
}
