/**
 * Process-level step effects: commands, vetted internal handlers, and
 * external effects (generators: steps-generator.ts). Children run through
 * core/process.ts (own process group, bounded time, AbortSignal, group
 * sweep), their output is redacted with every known secret and stored as
 * `logs/<stepId>.log` (mode 0600 — output can hold values no one declared).
 */
import { join } from "node:path";
import { RelPath } from "../contracts/common.ts";
import type { CommandAction, InternalAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { resolveInProject } from "../fs/paths.ts";
import { runProcess, type SpawnResult, tail } from "../process.ts";
import { redact } from "../redact.ts";
import { hashKeys, pathKind } from "./fsops.ts";
import { reservedName } from "./reserved.ts";
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

/** Logs may quote secrets nobody declared; only the owner may read them. */
const LOG_MODE = 0o600;

function logRefFor(stepId: string): string {
  return `logs/${stepId}.log`;
}

/** Persist a redacted log of one child run; returns its operation-relative path. */
export function writeLog(
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
  writeFileAtomic(join(sc.paths.dir, ref), redact(text, secrets), LOG_MODE);
  return ref;
}

export function failureMessage(label: string, result: SpawnResult, timeoutMs: number): string {
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
  const created = output.created.filter(
    (path) => RelPath.safeParse(path).success && reservedName(path) === null,
  );
  // Files a handler created beyond its declared touches are tracked like
  // touches (after-hashes), so rollback removes them when unchanged instead
  // of leaving them behind; created directories go when empty.
  const createdFiles = created.filter(
    (path) =>
      !action.touches.includes(path) && pathKind(resolveInProject(sc.root, path)) === "file",
  );
  return {
    outcome: "applied",
    after: await hashKeys(sc.root, [...new Set([...action.touches, ...createdFiles])]),
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
