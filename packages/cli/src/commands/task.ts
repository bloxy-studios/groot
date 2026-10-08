/**
 * `groot task create|list|show|run|resume|integrate` — bounded work for
 * installed coding agents (docs/v2-cli-spec.md#groot-task). Presentation
 * only: every behavior lives in core/tasks, shared with the MCP server.
 *
 * Exit codes: 0 when the task reached the expected state (created, awaiting
 * review, completed); 7 blocked (with the exact cause and next step); 5 when
 * the task failed its acceptance checks or attempts; 130 interrupted (resume
 * with `groot task resume`).
 */
import { realpathSync } from "node:fs";
import { defineCommand } from "citty";
import pc from "picocolors";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type { BlockedDecision } from "../core/contracts/envelope.ts";
import type { Attempt, Task } from "../core/contracts/task.ts";
import { EXIT_V2, exitCodeFor, GrootV2Error } from "../core/errors.ts";
import { gitTopLevel } from "../core/git.ts";
import type { CoreContext } from "../core/runtime.ts";
import {
  createTask,
  integrateTask,
  listTasks,
  readTask,
  resumeTask,
  runReadyTasks,
  runTask,
} from "../core/tasks/index.ts";

/** Repository root for task commands (works from any subdirectory). */
export async function taskRoot(ctx: CoreContext): Promise<string> {
  const top = await gitTopLevel(ctx.cwd);
  if (top === null) {
    throw new GrootV2Error("GROOT_E_USAGE", "groot tasks need a git repository.", {
      hint: "Run inside a git repository with at least one commit.",
    });
  }
  return realpathSync(top);
}

/**
 * Values of a repeatable flag (`--accept a --accept b`, `--accept=b`): citty
 * keeps only the last occurrence, so they are collected from the raw args.
 */
export function repeated(rawArgs: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === "--") break;
    if (arg === `--${flag}` && i + 1 < rawArgs.length) values.push(rawArgs[++i] as string);
    else if (arg.startsWith(`--${flag}=`)) values.push(arg.slice(flag.length + 3));
  }
  return values;
}

function numberFlag(name: string, value: string | undefined, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new GrootV2Error(
      "GROOT_E_USAGE",
      `--${name} must be a positive ${integer ? "integer" : "number"} (got "${value}").`,
    );
  }
  return parsed;
}

// ------------------------------------------------------------ rendering

const STATUS_COLOR: Record<Task["status"], (text: string) => string> = {
  pending: pc.cyan,
  running: pc.blue,
  blocked: pc.yellow,
  interrupted: pc.yellow,
  failed: pc.red,
  "awaiting-review": pc.magenta,
  completed: pc.green,
};

export function nextStep(task: Task): string | null {
  switch (task.status) {
    case "pending":
      return `groot task run ${task.id}`;
    case "running":
      return `groot task show ${task.id} (a run is in progress)`;
    case "blocked":
      return task.integration !== null
        ? `fix the cause above, then: groot task integrate ${task.id}`
        : `fix the cause above, then: groot task run ${task.id}`;
    case "interrupted":
      return `groot task resume ${task.id}`;
    case "failed":
      return `inspect .groot/tasks/${task.id}/, then: groot task resume ${task.id}`;
    case "awaiting-review":
      return `groot review ${task.id}  (then --approve and: groot task integrate ${task.id})`;
    case "completed":
      return null;
  }
}

function usageLine(attempt: Attempt): string {
  const { usage } = attempt;
  const parts: string[] = [];
  if (usage.costUsd !== null) parts.push(`≈$${usage.costUsd.toFixed(4)} est.`);
  if (usage.inputTokens !== null)
    parts.push(`${usage.inputTokens} in/${usage.outputTokens ?? 0} out tok`);
  if (usage.turns !== null) parts.push(`${usage.turns} turns`);
  parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export function renderTask(task: Task): void {
  const color = STATUS_COLOR[task.status];
  console.log(
    `${pc.bold(task.id)}  ${color(task.status)}  ${pc.dim(`${task.runner}${task.model === null ? "" : ` · ${task.model}`}`)}`,
  );
  console.log(`  ${task.title}`);
  if (task.statusReason !== null) console.log(`  ${pc.dim("reason:")} ${task.statusReason}`);
  if (task.worktree !== null)
    console.log(`  ${pc.dim("worktree:")} ${task.worktree.path} (${task.worktree.branch})`);
  for (const attempt of task.attempts) {
    const session = attempt.sessionId === null ? "" : pc.dim(`  session ${attempt.sessionId}`);
    console.log(`  #${attempt.n} ${attempt.status.padEnd(15)} ${usageLine(attempt)}${session}`);
    if (attempt.error !== null) console.log(`     ${pc.dim(attempt.error.message)}`);
  }
  if (task.evidence.length > 0) console.log(`  ${pc.dim("evidence:")} ${task.evidence.join(", ")}`);
  if (task.integration !== null) {
    console.log(
      `  ${pc.dim("integration:")} ${task.integration.status} — ${task.integration.detail}`,
    );
  }
  const next = nextStep(task);
  if (next !== null) console.log(`  ${pc.cyan("next:")} ${next}`);
}

function blockedDecision(task: Task): BlockedDecision {
  const credential = /\((?:unauthenticated|quota|config-incompatible)\)/.test(
    task.statusReason ?? "",
  );
  return {
    id: `task.${task.id}.blocked`,
    kind: credential ? "credential" : "prerequisite",
    question: task.statusReason ?? `Task ${task.id} is blocked.`,
    options: [],
    resolveWith: nextStep(task) ?? `groot task show ${task.id}`,
  };
}

/** Exit code for a task's state after a run/resume/integrate. */
export function taskExitCode(task: Task, expected: readonly Task["status"][]): number {
  if (expected.includes(task.status)) return EXIT_V2.OK;
  if (task.status === "interrupted") return EXIT_V2.CANCELLED;
  if (task.status === "blocked") return EXIT_V2.BLOCKED;
  if (task.status === "failed") return exitCodeFor("GROOT_E_VERIFY_FAILED");
  return EXIT_V2.INTERNAL;
}

function taskResult(task: Task, expected: readonly Task["status"][]): CommandResult {
  const exitCode = taskExitCode(task, expected);
  return {
    ok: exitCode === EXIT_V2.OK,
    data: task,
    exitCode,
    blocked: task.status === "blocked" ? [blockedDecision(task)] : [],
    refs: { taskId: task.id, evidence: task.evidence },
    human: () => renderTask(task),
  };
}

// ------------------------------------------------------------- commands

const flags = (args: { json: boolean; events: boolean }) => ({
  json: args.json,
  events: args.events,
});

const create = defineCommand({
  meta: { name: "create", description: "Create a task for an installed coding agent" },
  args: {
    objective: {
      type: "positional",
      required: false,
      description: "What the agent should achieve",
    },
    title: { type: "string", description: "Short title (default: the objective's first line)" },
    runner: { type: "string", default: "claude-code", description: "claude-code | codex" },
    model: { type: "string", description: "Model id or alias for the runner (e.g. opus)" },
    "depends-on": { type: "string", description: "Task that must be completed first (repeatable)" },
    owns: { type: "string", description: "Glob the task may change (repeatable; default **)" },
    accept: {
      type: "string",
      description: 'Acceptance command, run without a shell, e.g. "bun test" (repeatable)',
    },
    "accept-verify": {
      type: "string",
      description:
        "Acceptance verification profile: structural|build|runtime|product-flow (repeatable)",
    },
    "wall-time": { type: "string", description: "Wall time per attempt in seconds (default 900)" },
    "max-turns": { type: "string", description: "Turn limit per attempt (default 25)" },
    "max-budget-usd": {
      type: "string",
      description: "Spend cap per attempt, Claude Code only (default 2)",
    },
    "max-attempts": { type: "string", description: "Attempts per run, 1–5 (default 2)" },
    "accept-timeout": {
      type: "string",
      description: "Timeout per acceptance check in seconds (default 600)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("task create", flags(args), async (ctx) => {
      const objective = ((args._ as string[] | undefined) ?? []).join(" ").trim();
      const task = await createTask(ctx, await taskRoot(ctx), {
        objective,
        title: args.title ?? null,
        runner: args.runner as Task["runner"],
        model: args.model ?? null,
        dependsOn: repeated(rawArgs, "depends-on"),
        ownership: repeated(rawArgs, "owns"),
        accept: repeated(rawArgs, "accept"),
        acceptVerify: repeated(rawArgs, "accept-verify") as never[],
        acceptTimeoutSec: numberFlag("accept-timeout", args["accept-timeout"], true),
        limits: {
          wallTimeSec: numberFlag("wall-time", args["wall-time"], true),
          maxTurns: numberFlag("max-turns", args["max-turns"], true),
          maxBudgetUsd: numberFlag("max-budget-usd", args["max-budget-usd"], false),
          maxAttempts: numberFlag("max-attempts", args["max-attempts"], true),
        },
      });
      return taskResult(task, ["pending"]);
    });
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List tasks and their status" },
  args: { ...GLOBAL_ARGS },
  async run({ args }) {
    await runV2Command("task list", flags(args), async (ctx) => {
      const tasks = await listTasks(await taskRoot(ctx));
      return {
        ok: true,
        data: tasks,
        human: () => {
          if (tasks.length === 0)
            console.log(pc.dim('No tasks yet — create one with: groot task create "<objective>"'));
          for (const task of tasks) {
            console.log(
              `${task.id}  ${STATUS_COLOR[task.status](task.status.padEnd(15))} ${pc.dim(task.runner.padEnd(11))} ${task.title}`,
            );
          }
        },
      };
    });
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "Show a task: status, attempts with usage, evidence, next step",
  },
  args: { id: { type: "positional", required: true, description: "Task id" }, ...GLOBAL_ARGS },
  async run({ args }) {
    await runV2Command("task show", flags(args), async (ctx) => {
      const task = await readTask(await taskRoot(ctx), args.id);
      return {
        ok: true,
        data: task,
        refs: { taskId: task.id, evidence: task.evidence },
        human: () => renderTask(task),
      };
    });
  },
});

const run = defineCommand({
  meta: { name: "run", description: "Run a task (or every ready task) in its own git worktree" },
  args: {
    id: { type: "positional", required: false, description: "Task id (or use --ready)" },
    ready: {
      type: "boolean",
      default: false,
      description: "Run every task whose dependencies are completed",
    },
    parallel: { type: "string", default: "2", description: "Tasks at once with --ready (1–4)" },
    effort: {
      type: "string",
      description: "Reasoning effort for this run (Claude: low|medium|high|xhigh|max)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("task run", flags(args), async (ctx) => {
      const root = await taskRoot(ctx);
      const options = { effort: args.effort ?? null };
      if (args.ready === (args.id !== undefined)) {
        throw new GrootV2Error("GROOT_E_USAGE", "Give a task id or --ready (not both).", {
          hint: "groot task run <id>   or   groot task run --ready --parallel 2",
        });
      }
      if (args.id !== undefined)
        return taskResult(await runTask(ctx, root, args.id, options), ["awaiting-review"]);
      const parallel = numberFlag("parallel", args.parallel, true) ?? 2;
      const tasks = await runReadyTasks(ctx, root, { parallel, ...options });
      const codes = tasks.map((task) => taskExitCode(task, ["awaiting-review"]));
      const exitCode =
        [EXIT_V2.CANCELLED, exitCodeFor("GROOT_E_VERIFY_FAILED"), EXIT_V2.BLOCKED].find((code) =>
          codes.includes(code),
        ) ?? EXIT_V2.OK;
      return {
        ok: exitCode === EXIT_V2.OK,
        data: tasks,
        exitCode,
        blocked: tasks.filter((task) => task.status === "blocked").map(blockedDecision),
        refs: { evidence: tasks.flatMap((task) => task.evidence) },
        human: () => {
          if (tasks.length === 0)
            console.log(pc.dim("No ready tasks (pending with completed dependencies)."));
          for (const task of tasks) renderTask(task);
        },
      };
    });
  },
});

const resume = defineCommand({
  meta: {
    name: "resume",
    description: "Continue a task's runner session (after an interruption or failure)",
  },
  args: {
    id: { type: "positional", required: true, description: "Task id" },
    effort: { type: "string", description: "Reasoning effort for this run" },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("task resume", flags(args), async (ctx) =>
      taskResult(
        await resumeTask(ctx, await taskRoot(ctx), args.id, { effort: args.effort ?? null }),
        ["awaiting-review"],
      ),
    );
  },
});

const integrate = defineCommand({
  meta: {
    name: "integrate",
    description: "Merge an approved task after fresh checks; fast-forward a clean target branch",
  },
  args: { id: { type: "positional", required: true, description: "Task id" }, ...GLOBAL_ARGS },
  async run({ args }) {
    await runV2Command("task integrate", flags(args), async (ctx) => {
      const task = await integrateTask(ctx, await taskRoot(ctx), args.id);
      const result = taskResult(task, ["completed"]);
      return ctx.signal.aborted ? { ...result, ok: false, exitCode: EXIT_V2.CANCELLED } : result;
    });
  },
});

export const task = defineCommand({
  meta: {
    name: "task",
    description: "Delegate bounded work to installed coding agents (Claude Code, Codex)",
  },
  subCommands: { create, list, show, run, resume, integrate },
});
