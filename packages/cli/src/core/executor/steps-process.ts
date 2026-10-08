/**
 * Process-level step effects: commands, generators, vetted internal handlers,
 * and external effects. Children run through core/process.ts (own process
 * group, bounded time, AbortSignal, group sweep), their output is redacted
 * with every known secret and stored as `logs/<stepId>.log`.
 *
 * Generators run staged by default: in a fresh directory under the OS tmpdir
 * (a neutral ancestry — v1's runStagedGenerator rationale), and the result is
 * promoted into the project only after it exists. Promotion is a rename, or a
 * copy to a sibling temp directory followed by a rename when the tmpdir is on
 * another volume — so the destination is never observed half-written.
 */
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { RelPath } from "../contracts/common.ts";
import type { CommandAction, GeneratorAction, InternalAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { hashTree } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { runProcess, type SpawnResult, tail } from "../process.ts";
import { redact } from "../redact.ts";
import { STATE_DIR_NAME } from "../state.ts";
import { ensureParentDirs, hashKeys, pathKind, treeKey } from "./fsops.ts";
import {
  abortReason,
  childEnv,
  interruptedError,
  type StepContext,
  type StepEffect,
} from "./step-context.ts";
import type { InternalHandler } from "./types.ts";

/** Lines of output quoted in a failure message. */
const FAILURE_TAIL_LINES = 15;

function logRefFor(stepId: string): string {
  return `logs/${stepId}.log`;
}

/** Persist a redacted log of one child run; returns its operation-relative path. */
function writeLog(
  sc: StepContext,
  stepId: string,
  argv: readonly string[],
  cwd: string,
  result: SpawnResult,
): string {
  const secrets = sc.secrets.values();
  const status = result.aborted
    ? "aborted"
    : result.timedOut
      ? "timed out"
      : `exit ${result.exitCode ?? result.signal}`;
  const text = [
    `$ ${argv.join(" ")}`,
    `# cwd: ${cwd}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
    `--- ${status} after ${result.durationMs} ms ---`,
    "",
  ].join("\n");
  const ref = logRefFor(stepId);
  writeFileAtomic(join(sc.paths.dir, ref), redact(text, secrets));
  return ref;
}

function failureMessage(label: string, result: SpawnResult, timeoutMs: number): string {
  if (result.timedOut) return `${label} timed out after ${timeoutMs} ms.`;
  const output = tail(`${result.stdout}\n${result.stderr}`, FAILURE_TAIL_LINES);
  const code = result.exitCode ?? result.signal ?? "unknown";
  return `${label} failed (exit ${code})${output === "" ? "." : `:\n${output}`}`;
}

export async function commandStep(sc: StepContext, action: CommandAction): Promise<StepEffect> {
  const cwd = resolveInProject(sc.root, action.cwd);
  const result = await runProcess({
    argv: action.argv,
    cwd,
    env: childEnv(sc.ctx.env, action.env),
    stdin: action.stdin,
    timeoutMs: action.timeoutMs,
    signal: sc.ctx.signal,
    secrets: sc.secrets.values(),
  });
  const logRef = writeLog(sc, action.id, action.argv, action.cwd, result);
  if (result.aborted) throw interruptedError(action.id, abortReason(sc.ctx.signal));
  if (result.timedOut || result.exitCode !== 0) {
    throw new GrootV2Error(
      "GROOT_E_COMMAND_FAILED",
      failureMessage(`\`${action.argv.join(" ")}\``, result, action.timeoutMs),
      {
        hint: `Full output: .groot/operations/${sc.operationId}/${logRef}. Fix the cause, then \`groot resume ${sc.operationId}\`.`,
        details: {
          stepId: action.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          logRef,
        },
      },
    );
  }
  return {
    outcome: "applied",
    after: await hashKeys(sc.root, [...new Set(action.touches)]),
    created: [],
    logRef,
  };
}

/** Entries of a directory that count as content (Groot's own state never does). */
function contentEntries(abs: string): string[] {
  return readdirSync(abs).filter((entry) => entry !== STATE_DIR_NAME);
}

/** Move a grown tree into place: rename, or copy to a sibling temp + rename across volumes. */
function promoteTree(grown: string, dest: string): void {
  if (pathKind(dest) === "dir") {
    // An existing empty destination (e.g. the project root holding only .groot/): move entries in.
    for (const entry of readdirSync(grown)) promoteTree(join(grown, entry), join(dest, entry));
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(grown, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const sibling = `${dest}.groot-promote-${randomBytes(4).toString("hex")}`;
    cpSync(grown, sibling, { recursive: true, verbatimSymlinks: true });
    renameSync(sibling, dest);
  }
}

/** Remove what a generator produced: the whole tree, or only its new entries in a pre-existing dir. */
export function cleanProduced(root: string, produces: string, existedBefore: boolean): void {
  const abs = resolveInProject(root, produces);
  if (pathKind(abs) === "absent") return;
  if (!existedBefore || pathKind(abs) !== "dir") {
    rmSync(abs, { recursive: true, force: true });
    return;
  }
  for (const entry of contentEntries(abs))
    rmSync(join(abs, entry), { recursive: true, force: true });
}

function generatorFailed(
  sc: StepContext,
  action: GeneratorAction,
  message: string,
  logRef: string,
): GrootV2Error {
  return new GrootV2Error("GROOT_E_GENERATOR", message, {
    hint: `Full output: .groot/operations/${sc.operationId}/${logRef}. Nothing was promoted into ${action.produces}; \`groot resume ${sc.operationId}\` retries the generator.`,
    details: { stepId: action.id, generator: action.generator.package, logRef },
  });
}

async function runGenerator(
  sc: StepContext,
  action: GeneratorAction,
  cwd: string,
): Promise<{ result: SpawnResult; logRef: string }> {
  const result = await runProcess({
    argv: action.argv,
    cwd,
    env: childEnv(sc.ctx.env, {}),
    stdin: action.stdin,
    timeoutMs: action.timeoutMs,
    signal: sc.ctx.signal,
    secrets: sc.secrets.values(),
  });
  return { result, logRef: writeLog(sc, action.id, action.argv, action.cwd, result) };
}

async function stagedGenerator(
  sc: StepContext,
  action: GeneratorAction,
  dest: string,
): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "groot-stage-"));
  try {
    const { result, logRef } = await runGenerator(sc, action, stage);
    if (result.aborted) throw interruptedError(action.id, abortReason(sc.ctx.signal));
    if (result.timedOut || result.exitCode !== 0) {
      throw generatorFailed(
        sc,
        action,
        failureMessage(action.generator.package, result, action.timeoutMs),
        logRef,
      );
    }
    const grown = join(stage, basename(dest));
    if (pathKind(grown) !== "dir") {
      throw generatorFailed(
        sc,
        action,
        `${action.generator.package} finished but produced no "${basename(dest)}" directory.`,
        logRef,
      );
    }
    if (action.scrubGit) rmSync(join(grown, ".git"), { recursive: true, force: true });
    promoteTree(grown, dest);
    return logRef;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function inPlaceGenerator(
  sc: StepContext,
  action: GeneratorAction,
  dest: string,
  existedBefore: boolean,
): Promise<string> {
  const hadGit = pathKind(join(dest, ".git")) !== "absent";
  const { result, logRef } = await runGenerator(sc, action, resolveInProject(sc.root, action.cwd));
  if (result.aborted || result.timedOut || result.exitCode !== 0) {
    // Partial in-place output is indistinguishable from complete output: remove it.
    cleanProduced(sc.root, action.produces, existedBefore);
    if (result.aborted) throw interruptedError(action.id, abortReason(sc.ctx.signal));
    throw generatorFailed(
      sc,
      action,
      failureMessage(action.generator.package, result, action.timeoutMs),
      logRef,
    );
  }
  if (pathKind(dest) !== "dir") {
    throw generatorFailed(
      sc,
      action,
      `${action.generator.package} finished but did not create ${action.produces}.`,
      logRef,
    );
  }
  if (action.scrubGit && !hadGit) rmSync(join(dest, ".git"), { recursive: true, force: true });
  return logRef;
}

export async function generatorStep(sc: StepContext, action: GeneratorAction): Promise<StepEffect> {
  const dest = resolveInProject(sc.root, action.produces);
  const existedBefore = pathKind(dest) === "dir";
  if (existedBefore && contentEntries(dest).length > 0) {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${action.produces} is not empty; the generator needs a fresh directory.`,
      {
        details: { path: action.produces, conflict: "destination-not-empty" },
      },
    );
  }
  const created = action.produces === "." ? [] : ensureParentDirs(sc.root, action.produces);
  let logRef: string;
  try {
    logRef =
      action.mode === "staged"
        ? await stagedGenerator(sc, action, dest)
        : await inPlaceGenerator(sc, action, dest, existedBefore);
  } catch (error) {
    // On failure remove whatever this step put in place, so a retry starts clean.
    cleanProduced(sc.root, action.produces, existedBefore);
    throw error;
  }
  return {
    outcome: "applied",
    after: { [treeKey(action.produces)]: await hashTree(dest) },
    created,
    logRef,
  };
}

export async function internalStep(
  sc: StepContext,
  action: InternalAction,
  handler: InternalHandler | undefined,
): Promise<StepEffect> {
  if (handler === undefined) {
    throw new GrootV2Error(
      "GROOT_E_INTERNAL",
      `No internal handler "${action.handler}" is registered.`,
      {
        hint: "This plan was made by a newer or different groot build; re-plan with this version.",
        details: { stepId: action.id, handler: action.handler },
      },
    );
  }
  const output = await handler({
    root: sc.root,
    args: action.args,
    ctx: sc.ctx,
    stepId: action.id,
  });
  const created = output.created.filter((path) => RelPath.safeParse(path).success);
  return {
    outcome: "applied",
    after: await hashKeys(sc.root, [...new Set(action.touches)]),
    created,
    logRef: null,
  };
}

export function externalBlocked(provider: string, effect: string, stepId: string): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_BLOCKED",
    `Step ${stepId} needs an external effect (${provider}: ${effect}), but this groot build has no provider adapters to perform it.`,
    {
      hint: "Perform the provider change yourself, then re-plan without the external step.",
      details: { stepId, provider, effect },
    },
  );
}
