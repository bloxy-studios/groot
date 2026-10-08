/**
 * One runner attempt: record the attempt (status running) BEFORE the agent
 * starts — a crash leaves a trace with the pre-assigned session id — run it
 * with the task's limits in the task worktree, forward its events, and store
 * the classified result (status, exit code, usage, final message, error).
 * Runner notes (resolved executable, skipped wrapper shims, version, model,
 * swept processes) and the simulated flag are kept next to the attempt log.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Attempt, Task } from "../contracts/task.ts";
import { nowIso } from "../ids.ts";
import { redactValue } from "../redact.ts";
import { RUNNER_LABEL, unavailableUsage } from "../runners/common.ts";
import { getRunner } from "../runners/index.ts";
import type { RunnerEvent, RunnerResult } from "../runners/types.ts";
import type { CoreContext } from "../runtime.ts";
import { statusEntries } from "./git-ops.ts";
import { allowedCommands, taskRules } from "./prompt.ts";
import {
  appendPrompt,
  attemptLogRel,
  taskPaths,
  touch,
  writeAttemptSummary,
  writeTask,
} from "./store.ts";
import type { RunTaskOptions } from "./types.ts";

export interface AttemptPlan {
  readonly mode: "start" | "resume";
  readonly prompt: string;
  readonly resumeSessionId: string | null;
}

export interface AttemptOutcome {
  readonly task: Task;
  readonly result: RunnerResult;
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

/** Warn when the main checkout changed during the run (sandbox escape or a concurrent edit). */
function compareMainCheckout(
  ctx: CoreContext,
  taskId: string,
  before: readonly string[],
  after: readonly string[],
): void {
  const changed = after.filter((entry) => !before.includes(entry));
  if (changed.length === 0) return;
  ctx.events.emit({
    type: "task.warning",
    level: "warn",
    message: `${taskId}: the main checkout changed while the runner worked (possible sandbox escape or a concurrent edit): ${changed.slice(0, 5).join(", ")}`,
    taskId,
    data: { changed },
  });
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
  const n = task.attempts.length + 1;
  const preassigned = randomUUID();
  const running: Attempt = {
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
  let current = writeTask(root, touch(task, { attempts: [...task.attempts, running] }));
  appendPrompt(root, task.id, `Attempt ${n} (${plan.mode}) — ${running.startedAt}`, plan.prompt);
  ctx.events.emit({
    type: "task.attempt.started",
    level: "info",
    message: `${task.id}: attempt ${n}/${task.limits.maxAttempts} (${plan.mode}) with ${RUNNER_LABEL[task.runner]}${task.model === null ? "" : ` · model ${task.model}`}`,
    taskId: task.id,
    data: { attempt: n, mode: plan.mode },
  });

  const before = await statusEntries(root, ctx.env);
  const handle = getRunner(task.runner).start({
    cwd: worktree.path,
    prompt: plan.prompt,
    sessionId: preassigned,
    resumeSessionId: plan.resumeSessionId,
    model: task.model,
    effort: options.effort ?? null,
    limits: {
      maxTurns: task.limits.maxTurns,
      maxBudgetUsd: task.runner === "claude-code" ? task.limits.maxBudgetUsd : null,
      wallTimeMs: task.limits.wallTimeSec * 1000,
    },
    allowedCommands: allowedCommands(task),
    eventsLogPath: taskPaths.attemptLog(root, task.id, n),
    signal: ctx.signal,
    systemPrompt: taskRules(task),
    env: ctx.env,
    grace: options.grace,
  });
  const forwarding = forwardEvents(ctx, task.id, handle.events);
  const result = await handle.result;
  await forwarding;
  compareMainCheckout(ctx, task.id, before, await statusEntries(root, ctx.env));

  const summary = redactValue({
    status: result.status,
    simulated: result.simulated,
    notes: [...result.notes],
  });
  appendFileSync(
    taskPaths.attemptLog(root, task.id, n),
    `${JSON.stringify({ type: "groot.result", at: nowIso(), ...summary })}\n`,
  );
  writeAttemptSummary(root, task.id, n, summary);
  const finished: Attempt = {
    ...running,
    sessionId: result.sessionId,
    finishedAt: nowIso(),
    status: result.status,
    exitCode: result.exitCode,
    usage: result.usage,
    finalMessage: result.finalMessage,
    error: result.error,
  };
  current = writeTask(
    root,
    touch(current, { attempts: [...current.attempts.slice(0, -1), finished] }),
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
    message: `${task.id}: attempt ${n} ${result.status}${result.simulated ? " (simulated)" : ""}${usageText(result)}${result.error === null ? "" : ` — ${result.error.message}`}`,
    taskId: task.id,
    data: { attempt: n, status: result.status, simulated: result.simulated },
  });
  return { task: current, result };
}
