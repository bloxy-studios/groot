/**
 * One runner attempt: record the attempt (status running) BEFORE the agent
 * starts — a crash leaves a trace with the pre-assigned session id — run it
 * with the task's limits in the task worktree, forward its events, and store
 * the classified result (status, exit code, usage, final message, error).
 * Runner notes (resolved executable, skipped wrapper shims, version, model,
 * swept processes) and the simulated flag are kept next to the attempt log.
 *
 * While the runner process exists, runner.json records its process group, so
 * a later Groot can stop it if this one dies. The repository's git directory
 * is passed as a protected path, and the repository guard (guard.ts) compares
 * every ref, both HEADs, and the git directory's hooks and config before and
 * after: what the agent must not change is reported as the attempt's
 * tampering.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Attempt, Task } from "../contracts/task.ts";
import { nowIso } from "../ids.ts";
import { redactValue } from "../redact.ts";
import { RUNNER_LABEL, unavailableUsage } from "../runners/common.ts";
import { getRunner } from "../runners/index.ts";
import type { RunnerEvent, RunnerInvocation, RunnerResult } from "../runners/types.ts";
import type { CoreContext } from "../runtime.ts";
import { gitCommonDir } from "./git-ops.ts";
import { watchRepository } from "./guard.ts";
import type { AttemptPlan } from "./plans.ts";
import { allowedCommands, taskRules } from "./prompt.ts";
import {
  appendPrompt,
  attemptLogRel,
  taskPaths,
  touch,
  writeAttemptSummary,
  writeMarker,
  writeTask,
} from "./store.ts";
import type { RunTaskOptions } from "./types.ts";

export interface AttemptOutcome {
  readonly task: Task;
  readonly result: RunnerResult;
  /** What changed in the repository during the attempt but must not have (refs, git directory). */
  readonly tampering: readonly string[];
}

const INFO_KINDS: ReadonlySet<RunnerEvent["kind"]> = new Set(["session", "tool", "result"]);

async function forwardEvents(
  ctx: CoreContext,
  taskId: string,
  events: AsyncIterable<RunnerEvent>,
): Promise<void> {
  for await (const event of events) {
    ctx.events.emit({
      type: "runner.event",
      level: INFO_KINDS.has(event.kind) ? "info" : "debug",
      message: `${taskId} ${event.summary}`,
      taskId,
      data: { kind: event.kind, event: event.type },
    });
  }
}

function usageText(result: RunnerResult): string {
  const { usage } = result;
  const parts: string[] = [];
  if (usage.costUsd !== null) parts.push(`≈$${usage.costUsd.toFixed(4)} (estimate)`);
  if (usage.inputTokens !== null)
    parts.push(`${usage.inputTokens} in / ${usage.outputTokens ?? 0} out tokens`);
  if (usage.turns !== null) parts.push(`${usage.turns} turns`);
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/** Persist the attempt as running (with the session id it will use) before anything starts. */
function recordStart(
  ctx: CoreContext,
  root: string,
  task: Task,
  plan: AttemptPlan,
  preassigned: string,
): { task: Task; attempt: Attempt } {
  const n = task.attempts.length + 1;
  const attempt: Attempt = {
    n,
    runner: task.runner,
    sessionId:
      plan.mode === "resume"
        ? plan.resumeSessionId
        : task.runner === "claude-code"
          ? preassigned
          : null,
    resumedFrom: plan.mode === "resume" ? plan.resumeSessionId : null,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    exitCode: null,
    usage: unavailableUsage(0, "attempt in progress"),
    eventsLog: attemptLogRel(root, task.id, n),
    finalMessage: null,
    error: null,
  };
  const current = writeTask(root, touch(task, { attempts: [...task.attempts, attempt] }));
  appendPrompt(root, task.id, `Attempt ${n} (${plan.mode}) — ${attempt.startedAt}`, plan.prompt);
  ctx.events.emit({
    type: "task.attempt.started",
    level: "info",
    message: `${task.id}: attempt ${n}/${task.limits.maxAttempts} (${plan.mode}) with ${RUNNER_LABEL[task.runner]}${task.model === null ? "" : ` · model ${task.model}`}`,
    taskId: task.id,
    data: { attempt: n, mode: plan.mode },
  });
  return { task: current, attempt };
}

function invocation(
  ctx: CoreContext,
  root: string,
  task: Task,
  run: { plan: AttemptPlan; preassigned: string; worktree: string; protectedPath: string },
  options: RunTaskOptions,
): RunnerInvocation {
  return {
    cwd: run.worktree,
    prompt: run.plan.prompt,
    sessionId: run.preassigned,
    resumeSessionId: run.plan.resumeSessionId,
    model: task.model,
    effort: options.effort ?? null,
    limits: {
      maxTurns: task.limits.maxTurns,
      maxBudgetUsd: task.runner === "claude-code" ? task.limits.maxBudgetUsd : null,
      wallTimeMs: task.limits.wallTimeSec * 1000,
    },
    allowedCommands: allowedCommands(task),
    protectedPaths: [run.protectedPath],
    eventsLogPath: taskPaths.attemptLog(root, task.id, task.attempts.length + 1),
    signal: ctx.signal,
    systemPrompt: taskRules(task),
    env: ctx.env,
    grace: options.grace,
    onSpawn: (pid) => writeMarker(root, task.id, { pgid: pid, startedAt: Date.now() }),
  };
}

/** Store the classified result on the attempt (plus its sidecar summary) and report it. */
function recordFinish(
  ctx: CoreContext,
  root: string,
  task: Task,
  attempt: Attempt,
  result: RunnerResult,
): Task {
  const summary = redactValue({
    status: result.status,
    simulated: result.simulated,
    notes: [...result.notes],
  });
  appendFileSync(
    taskPaths.attemptLog(root, task.id, attempt.n),
    `${JSON.stringify({ type: "groot.result", at: nowIso(), ...summary })}\n`,
  );
  writeAttemptSummary(root, task.id, attempt.n, summary);
  const finished: Attempt = {
    ...attempt,
    sessionId: result.sessionId,
    finishedAt: nowIso(),
    status: result.status,
    exitCode: result.exitCode,
    usage: result.usage,
    finalMessage: result.finalMessage,
    error: result.error,
  };
  const current = writeTask(
    root,
    touch(task, { attempts: [...task.attempts.slice(0, -1), finished] }),
  );
  for (const note of result.notes) {
    ctx.events.emit({
      type: "runner.note",
      level: "debug",
      message: `${task.id} ${note}`,
      taskId: task.id,
    });
  }
  ctx.events.emit({
    type: "task.attempt.finished",
    level: result.status === "succeeded" ? "info" : "warn",
    message: `${task.id}: attempt ${attempt.n} ${result.status}${result.simulated ? " (simulated)" : ""}${usageText(result)}${result.error === null ? "" : ` — ${result.error.message}`}`,
    taskId: task.id,
    data: { attempt: attempt.n, status: result.status, simulated: result.simulated },
  });
  return current;
}

/** Run one attempt for a claimed (running) task with a worktree. */
export async function runAttempt(
  ctx: CoreContext,
  root: string,
  task: Task,
  plan: AttemptPlan,
  options: RunTaskOptions,
): Promise<AttemptOutcome> {
  const worktree = task.worktree;
  if (worktree === null) throw new Error(`task ${task.id} has no worktree`);
  const preassigned = randomUUID();
  const protectedPath = await gitCommonDir(root, ctx.env);
  const run = { plan, preassigned, worktree: worktree.path, protectedPath };
  const spec = invocation(ctx, root, task, run, options);
  const watch = await watchRepository(ctx, root, worktree.path, task.id, "the runner worked");
  const started = recordStart(ctx, root, task, plan, preassigned);

  const handle = getRunner(task.runner).start(spec);
  const forwarding = forwardEvents(ctx, task.id, handle.events);
  const result = await handle.result;
  await forwarding;
  writeMarker(root, task.id); // the runner's group is gone (swept)
  const current = recordFinish(ctx, root, started.task, started.attempt, result);
  return { task: current, result, tampering: await watch.finish() };
}
