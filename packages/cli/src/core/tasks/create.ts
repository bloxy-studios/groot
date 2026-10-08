/**
 * Task creation: validate untrusted input (objective, runner, model,
 * dependencies, ownership globs, acceptance commands/profiles, limits), pin
 * the base (current branch + HEAD — the repository needs one commit), and
 * persist the pending task. Nothing runs here.
 */
import { schemaUrl, VerificationProfile } from "../contracts/common.ts";
import { type AcceptanceCriterion, RunnerId, type Task, TaskLimits } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { newId, nowIso } from "../ids.ts";
import { assertSafeArg } from "../runners/common.ts";
import type { CoreContext } from "../runtime.ts";
import { formatArgv, splitCommand } from "./argv.ts";
import { currentBranch, repositoryRoot, revParse } from "./git-ops.ts";
import { validateOwnership } from "./ownership.ts";
import { assertTaskId, readTask, writeTask } from "./store.ts";
import {
  type CreateTaskInput,
  DEFAULT_ACCEPT_TIMEOUT_SEC,
  DEFAULT_CLAUDE_BUDGET_USD,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_TURNS,
  DEFAULT_WALL_TIME_SEC,
} from "./types.ts";

const TITLE_MAX = 72;

function usage(message: string, hint?: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_USAGE", message, hint === undefined ? {} : { hint });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function titleFor(objective: string, title: string | null | undefined): string {
  const explicit = title?.trim() ?? "";
  if (explicit !== "") return explicit;
  const firstLine = objective.split("\n")[0]?.trim() ?? objective;
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

export function buildLimits(runner: RunnerId, partial: CreateTaskInput["limits"]): TaskLimits {
  const parsed = TaskLimits.safeParse({
    wallTimeSec: partial?.wallTimeSec ?? DEFAULT_WALL_TIME_SEC,
    maxTurns: partial?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd:
      partial?.maxBudgetUsd !== undefined
        ? partial.maxBudgetUsd
        : runner === "claude-code"
          ? DEFAULT_CLAUDE_BUDGET_USD
          : null,
    maxAttempts: partial?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw usage(
      `Invalid task limits: ${issue?.path.join(".") ?? "limits"} ${issue?.message ?? ""}`.trim(),
      "wall time and turns are positive integers, the budget is a positive number, attempts are 1–5.",
    );
  }
  return parsed.data;
}

export function buildAcceptance(input: CreateTaskInput): AcceptanceCriterion[] {
  const seconds = input.acceptTimeoutSec ?? DEFAULT_ACCEPT_TIMEOUT_SEC;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw usage("The acceptance timeout must be a positive number of seconds.");
  }
  const timeoutMs = seconds * 1000;
  const commands = (input.accept ?? []).map((command, index): AcceptanceCriterion => {
    const argv = splitCommand(command);
    return {
      id: `accept-${index + 1}`,
      description: formatArgv(argv),
      kind: "command",
      argv,
      cwd: ".",
      profile: null,
      timeoutMs,
    };
  });
  const profiles = unique(input.acceptVerify ?? []).map((value): AcceptanceCriterion => {
    const profile = VerificationProfile.safeParse(value);
    if (!profile.success) {
      throw usage(
        `Unknown verification profile "${value}".`,
        `Use one of: ${VerificationProfile.options.join(", ")}.`,
      );
    }
    return {
      id: `verify-${profile.data}`,
      description: `groot verification profile "${profile.data}"`,
      kind: "verify",
      argv: null,
      cwd: ".",
      profile: profile.data,
      timeoutMs,
    };
  });
  return [...commands, ...profiles];
}

async function checkDependencies(root: string, ids: readonly string[]): Promise<string[]> {
  const dependsOn = unique(ids.map((id) => assertTaskId(id.trim())));
  for (const id of dependsOn) await readTask(root, id);
  return dependsOn;
}

/** Create and persist a pending task (see the module comment). */
export async function createTask(
  ctx: CoreContext,
  root: string,
  input: CreateTaskInput,
): Promise<Task> {
  const repo = await repositoryRoot(root, ctx.env);
  const objective = input.objective?.trim() ?? "";
  if (objective === "")
    throw usage(
      "A task needs an objective.",
      'Example: groot task create "make the failing test pass"',
    );
  const runnerParse = RunnerId.safeParse(input.runner ?? "claude-code");
  if (!runnerParse.success) {
    throw usage(
      `Unknown runner "${String(input.runner)}".`,
      `Use one of: ${RunnerId.options.join(", ")}.`,
    );
  }
  const runner = runnerParse.data;
  const model = input.model?.trim() ? assertSafeArg("model", input.model.trim()) : null;
  const ownership = unique(
    (input.ownership !== undefined && input.ownership.length > 0 ? input.ownership : ["**"]).map(
      validateOwnership,
    ),
  );
  const acceptance = buildAcceptance(input);
  const limits = buildLimits(runner, input.limits);
  const dependsOn = await checkDependencies(repo, input.dependsOn ?? []);
  const commit = await revParse(repo, "HEAD", ctx.env);
  if (commit === null) throw usage("The repository has no commits yet.");
  const now = nowIso();
  const task = writeTask(repo, {
    $schema: schemaUrl("task"),
    schemaVersion: 1,
    kind: "groot.task",
    id: newId("task"),
    title: titleFor(objective, input.title),
    objective,
    createdAt: now,
    updatedAt: now,
    runner,
    model,
    dependsOn,
    ownership,
    acceptance,
    limits,
    status: "pending",
    statusReason: null,
    base: { branch: await currentBranch(repo, ctx.env), commit },
    worktree: null,
    attempts: [],
    evidence: [],
    review: null,
    integration: null,
  });
  if (runner === "codex" && limits.maxBudgetUsd !== null) {
    ctx.events.emit({
      type: "task.warning",
      level: "warn",
      message: `Codex has no spend limit: maxBudgetUsd ${limits.maxBudgetUsd} is recorded but not enforced.`,
      taskId: task.id,
    });
  }
  if (acceptance.length === 0) {
    ctx.events.emit({
      type: "task.warning",
      level: "warn",
      message:
        "No acceptance criteria: completion will rest on the runner's own success and your review.",
      taskId: task.id,
    });
  }
  ctx.events.emit({
    type: "task.created",
    level: "info",
    message: `Created ${task.id}: ${task.title}`,
    taskId: task.id,
  });
  return task;
}
