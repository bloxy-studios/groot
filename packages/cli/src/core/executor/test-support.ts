/**
 * Test-only helpers for executor and apply/resume/rollback CLI tests (never
 * imported by runtime code): scratch projects, plans built with the real
 * PlanBuilder, contract-validated journal/state readers, and tree snapshots
 * for byte-identical comparisons.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Policy } from "../contracts/blueprint.ts";
import { DEFAULT_POLICY } from "../contracts/blueprint.ts";
import type { GrootEvent } from "../contracts/envelope.ts";
import {
  type JournalRecord,
  JournalRecord as JournalRecordSchema,
  type OperationState,
  OperationState as OperationStateSchema,
} from "../contracts/operation.ts";
import type { OperationPlan, PlanIntent } from "../contracts/plan.ts";
import { PlanBuilder } from "../planner/builder.ts";
import { type CoreContext, collectingSink, createContext } from "../runtime.ts";
import { statePaths } from "../state.ts";

export const CONTEXT_INTENT: PlanIntent = { type: "context-sync" };

/** A scratch project with the given files (paths → content). */
export function scratchProject(files: Record<string, string> = {}, prefix = "groot-exec-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** git init + commit everything (identity isolated from the machine's config). */
export async function gitInit(root: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init", "--allow-empty"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: root, env, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
    }
  }
}

/** Build a plan with the real PlanBuilder. */
export async function buildPlan(
  root: string,
  add: (builder: PlanBuilder) => Promise<void>,
  intent: PlanIntent = CONTEXT_INTENT,
): Promise<OperationPlan> {
  const builder = new PlanBuilder({
    root,
    intent,
    summary: "executor test plan",
    topology: "single",
    revision: { vcs: "none", head: null, branch: null, dirty: false, worktreeFingerprint: null },
    createdWith: "create-groot@2.0.0",
  });
  await add(builder);
  return builder.build();
}

export interface TestContext {
  readonly ctx: CoreContext;
  readonly events: GrootEvent[];
  readonly controller: AbortController;
}

export function testContext(cwd: string, onEvent?: (event: GrootEvent) => void): TestContext {
  const sink = collectingSink();
  const controller = new AbortController();
  const ctx = createContext({
    cwd,
    signal: controller.signal,
    events: {
      emit(input) {
        sink.emit(input);
        const event = sink.events[sink.events.length - 1];
        if (event !== undefined) onEvent?.(event);
      },
    },
  });
  return { ctx, events: sink.events, controller };
}

export const permissive: Policy = DEFAULT_POLICY;

export function operationDir(root: string, operationId: string): string {
  return statePaths.operation(root, operationId);
}

export function operationIds(root: string): string[] {
  try {
    return readdirSync(statePaths.operations(root))
      .filter((id) => id.startsWith("op_"))
      .sort();
  } catch {
    return [];
  }
}

/** Every journal line, each validated against the JournalRecord contract. */
export function journalRecords(root: string, operationId: string): JournalRecord[] {
  const text = readFileSync(join(operationDir(root, operationId), "journal.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JournalRecordSchema.parse(JSON.parse(line)));
}

export function stateFile(root: string, operationId: string): OperationState {
  const text = readFileSync(join(operationDir(root, operationId), "state.json"), "utf8");
  return OperationStateSchema.parse(JSON.parse(text));
}

export interface TreeEntry {
  readonly content: string;
  readonly mode: number;
}

/** Files under `root` (excluding .groot, .git, node_modules) → content + mode. */
export function snapshot(root: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".groot" || name === ".git" || name === "node_modules") continue;
      const abs = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const info = statSync(abs);
      if (info.isDirectory()) {
        out[`${rel}/`] = { content: "", mode: info.mode & 0o777 };
        walk(abs, rel);
      } else {
        out[rel] = { content: readFileSync(abs, "utf8"), mode: info.mode & 0o777 };
      }
    }
  };
  walk(root, "");
  return out;
}

/** Every file under `dir`, recursively (absolute paths). */
export function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** True when any file under `dir` contains `needle`. */
export function anyFileContains(dir: string, needle: string): string | null {
  for (const file of allFiles(dir)) {
    if (readFileSync(file, "latin1").includes(needle)) return file;
  }
  return null;
}

export function setMode(root: string, path: string, mode: number): void {
  chmodSync(join(root, path), mode);
}

// ---------------------------------------------------------------------------
// Process-level CLI helpers (piped stdio — the CI/agent environment)
// ---------------------------------------------------------------------------

export const CLI_ENTRY = join(import.meta.dir, "../../index.ts");

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signalCode: string | null;
}

export interface SpawnedCli {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly done: Promise<CliRun>;
}

/** Start the CLI from source with piped stdio; `done` resolves with everything it printed. */
export function spawnCli(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): SpawnedCli {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
  const done = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({
    stdout,
    stderr,
    exitCode,
    signalCode: proc.signalCode ?? null,
  }));
  return { proc, done };
}

export function runCli(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<CliRun> {
  return spawnCli(cwd, args, env).done;
}

/** Write a plan to a file OUTSIDE the project (so it never shows up in tree comparisons). */
export function writePlanFile(plan: OperationPlan): string {
  const dir = mkdtempSync(join(tmpdir(), "groot-plan-"));
  const file = join(dir, "plan.json");
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  return file;
}

/** Parse a --json result envelope from stdout. */
export function envelopeOf(run: CliRun): {
  ok: boolean;
  data: Record<string, unknown>;
  error: { id: string; details: Record<string, unknown> | null } | null;
  blocked: { id: string; resolveWith: string }[];
  refs: { operationId: string | null; planId: string | null };
} {
  return JSON.parse(run.stdout);
}

/** Poll until `predicate` holds (deterministic waits instead of fixed sleeps). */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Action helpers (everything still goes through PlanBuilder.add)
// ---------------------------------------------------------------------------

export async function addDelete(builder: PlanBuilder, path: string): Promise<string> {
  return builder.add({
    type: "file.delete",
    path,
    expect: await builder.expectationFor(path),
    recursive: false,
    description: `delete ${path}`,
    classes: ["fs.delete"],
    reversible: true,
    compensation: `restore ${path} from backup`,
  });
}

export async function addDeps(
  builder: PlanBuilder,
  changes: { package: string; to: string; dev: boolean }[],
  unit = ".",
): Promise<string> {
  const pkg = unit === "." ? "package.json" : `${unit}/package.json`;
  return builder.add({
    type: "deps.add",
    unit,
    changes: changes.map((change) => ({ ...change, unit, from: null })),
    expect: await builder.expectationFor(pkg),
    description: `add ${changes.map((change) => change.package).join(", ")}`,
    classes: ["deps.change"],
    reversible: true,
    compensation: `restore ${pkg} and re-run bun install`,
  });
}

export interface CommandOptions {
  readonly touches?: string[];
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  readonly description?: string;
}

export function addCommand(
  builder: PlanBuilder,
  script: string,
  options: CommandOptions = {},
): string {
  return builder.add({
    type: "command.run",
    argv: ["sh", "-c", script],
    cwd: ".",
    purpose: "script",
    network: false,
    idempotent: options.idempotent ?? false,
    timeoutMs: options.timeoutMs ?? 60_000,
    env: {},
    stdin: null,
    touches: options.touches ?? [],
    description: options.description ?? `run ${script}`,
    classes: ["command"],
    reversible: true,
    compensation: "restore touched files from backup",
  });
}

export function addSecret(builder: PlanBuilder, path: string, name: string): string {
  return builder.add({
    type: "env.secret",
    path,
    name,
    generator: "random-secret",
    description: `generate ${name} in ${path}`,
    classes: ["fs.edit"],
    reversible: true,
    compensation: `restore ${path} from backup`,
  });
}

/** Files of the canonical multi-step project. package.json uses 4-space indentation on purpose. */
export const MULTI_STEP_FILES: Record<string, string> = {
  "README.md": "# Demo\n",
  "package.json":
    '{\n    "name": "demo",\n    "version": "1.0.0",\n    "dependencies": {\n        "zod": "4.0.0"\n    }\n}\n',
  "obsolete.txt": "old\n",
  "unrelated.txt": "keep\n",
};

/**
 * write · precomputed edit · deferred edit · deps.add · command appending to
 * a file · delete · env.secret — the canonical multi-step plan.
 */
export async function multiStepPlan(root: string): Promise<OperationPlan> {
  return buildPlan(root, async (b) => {
    await b.writeFile({
      path: "src/greeting.ts",
      content: 'export const greeting = "hi";\n',
      description: "create src/greeting.ts",
    });
    await b.editFile({
      path: "README.md",
      edit: { kind: "lines", lines: ["Managed by groot."], header: null },
      description: "note groot in README.md",
      owns: [],
      createIfMissing: false,
    });
    await b.editFile({
      path: "src/greeting.ts",
      edit: { kind: "lines", lines: ["export const extra = 1;"], header: null },
      description: "extend src/greeting.ts",
      owns: [],
      createIfMissing: false,
      deferred: true,
    });
    await addDeps(b, [
      { package: "left-pad", to: "1.3.0", dev: false },
      { package: "typescript", to: "5.9.2", dev: true },
    ]);
    addCommand(b, "echo ran >> log.txt", {
      touches: ["log.txt"],
      description: "append to log.txt",
    });
    await addDelete(b, "obsolete.txt");
    addSecret(b, ".env.local", "APP_SECRET");
  });
}
