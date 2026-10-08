/**
 * Task tools: bounded work for an installed coding agent (Claude Code or
 * Codex) in an isolated worktree, with acceptance checks, review, and
 * integration. A task is done when its acceptance checks pass and a review
 * approves it — not when an agent says so. Long runs are background jobs
 * with bounded waits, like operations.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { VerificationProfile } from "../contracts/common.ts";
import type { Task } from "../contracts/task.ts";
import { createContext } from "../runtime.ts";
import type { ToolDeps } from "./deps.ts";
import { clampWait } from "./jobs.ts";
import { fail, ok, type ToolResult } from "./results.ts";

const Root = z
  .string()
  .optional()
  .describe("Absolute path of the project (default: where groot mcp started)");
const WaitMs = z
  .number()
  .int()
  .min(0)
  .max(45_000)
  .optional()
  .describe("Max wait in this call (default 20000, max 45000)");
const Summary = z.looseObject({ summary: z.string(), next: z.array(z.string()) });

function compactTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    runner: task.runner,
    status: task.status,
    statusReason: task.statusReason,
    dependsOn: task.dependsOn,
    attempts: task.attempts.map((attempt) => ({
      n: attempt.n,
      status: attempt.status,
      sessionId: attempt.sessionId,
      usage: attempt.usage,
    })),
    evidence: task.evidence,
    review: task.review,
    integration: task.integration,
  };
}

function nextFor(task: Task): string[] {
  switch (task.status) {
    case "pending":
      return [`Call task_run with id=${task.id}.`];
    case "running":
      return [`Call task_status with id=${task.id} to follow it.`];
    case "awaiting-review":
      return [
        `Call task_review with id=${task.id} to see the change set; approve only after the user agrees.`,
      ];
    case "blocked":
      return [`Resolve: ${task.statusReason ?? "see statusReason"}, then call task_run again.`];
    case "interrupted":
    case "failed":
      return [
        `Inspect the attempts and evidence; call task_run with id=${task.id} to retry if appropriate.`,
      ];
    case "completed":
      return ["Done — the change is integrated and verified."];
  }
}

export function registerTaskTools(server: McpServer, deps: ToolDeps): void {
  const rootOf = (input: string | undefined): string => deps.api.projectRoot(input ?? deps.cwd);
  const background = (root: string, signal: AbortSignal) =>
    createContext({ cwd: root, signal, events: deps.events });

  const report = (task: Task): ToolResult =>
    ok({
      summary: `Task ${task.id} (${task.title}) is ${task.status}${task.statusReason ? `: ${task.statusReason}` : ""}.`,
      next: nextFor(task),
      task: compactTask(task),
    });

  server.registerTool(
    "task_create",
    {
      title: "Create an agent task",
      description:
        "Define bounded work for an installed coding agent: objective, runner (claude-code or codex), dependencies, file ownership globs, and acceptance checks (commands and/or verification profiles). Nothing runs until task_run.",
      inputSchema: z.strictObject({
        root: Root,
        objective: z.string().min(1).describe("What the agent must achieve"),
        title: z.string().optional(),
        runner: z.enum(["claude-code", "codex"]).describe("Installed agent to run the task"),
        model: z.string().optional().describe("Runner model (default: the runner's own default)"),
        dependsOn: z.array(z.string()).optional().describe("Task ids that must complete first"),
        ownership: z
          .array(z.string())
          .optional()
          .describe("Project-relative globs the task may change (default **)"),
        accept: z.array(z.string()).optional().describe('Acceptance commands, e.g. "bun test"'),
        acceptVerify: z
          .array(VerificationProfile)
          .optional()
          .describe("Verification profiles that must pass"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      try {
        const projectRoot = rootOf(input.root);
        const task = await deps.api.createTask(
          background(projectRoot, ctx.mcpReq.signal),
          projectRoot,
          input,
        );
        return report(task);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "task_status",
    {
      title: "Task status",
      description:
        "One task (attempts, usage, evidence, review, integration), or all tasks without an id.",
      inputSchema: z.strictObject({ root: Root, id: z.string().optional(), waitMs: WaitMs }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, id, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        if (id === undefined) {
          const tasks = await deps.api.listTasks(projectRoot);
          return ok({
            summary: `${tasks.length} task(s): ${tasks.map((task) => `${task.id} ${task.status}`).join(", ") || "none"}.`,
            next: [],
            tasks: tasks.map(compactTask),
          });
        }
        const job = deps.jobs.find(`task:${id}`);
        if (job !== undefined && !job.done && waitMs !== 0)
          await deps.jobs.wait(job, clampWait(waitMs), ctx.mcpReq.signal);
        return report(await deps.api.readTask(projectRoot, id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "task_run",
    {
      title: "Run a task",
      description:
        "Run a pending/failed/interrupted task with its agent in an isolated git worktree, then commit the result and run its acceptance checks. Checks dependencies, ownership overlap, and that the agent is installed and logged in (otherwise blocked with the cause). Returns within waitMs; poll task_status.",
      inputSchema: z.strictObject({ root: Root, id: z.string(), waitMs: WaitMs }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ root, id, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const job = deps.jobs.start(`task:${id}`, `task:${id}`, (signal) =>
          deps.api.runTask(background(projectRoot, signal), projectRoot, id),
        );
        const settled = await deps.jobs.wait(job, clampWait(waitMs), ctx.mcpReq.signal);
        if (settled && job.error !== undefined) return fail(job.error);
        return report(settled ? (job.result as Task) : await deps.api.readTask(projectRoot, id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "task_review",
    {
      title: "Review a task",
      description:
        "Summarize a task's change set (files, ownership violations, secret findings by location, acceptance results). approve or requestChanges record the human verdict — set them only when the user decided.",
      inputSchema: z.strictObject({
        root: Root,
        id: z.string(),
        approve: z.boolean().optional(),
        requestChanges: z.string().optional().describe("Notes for the next attempt"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ root, id, approve, requestChanges }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const review = await deps.api.reviewTask(
          background(projectRoot, ctx.mcpReq.signal),
          projectRoot,
          id,
          {
            approve,
            requestChanges,
          },
        );
        return ok({
          summary: `Review ${review.id}: ${review.files.length} file(s) changed, ${review.ownershipViolations.length} ownership violation(s), ${review.secretFindings.length} secret finding(s); verdict ${review.verdict}.`,
          next: review.verdict === "approved" ? [`Call task_integrate with id=${id}.`] : [],
          review,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "task_integrate",
    {
      title: "Integrate a task",
      description:
        "Merge an approved task in a fresh integration worktree, re-run its acceptance checks and verification there, and fast-forward the target branch only if the user's checkout is clean (otherwise the integration branch is left for them).",
      inputSchema: z.strictObject({ root: Root, id: z.string(), waitMs: WaitMs }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ root, id, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const job = deps.jobs.start(`integrate:${id}`, `integrate:${id}`, (signal) =>
          deps.api.integrateTask(background(projectRoot, signal), projectRoot, id),
        );
        const settled = await deps.jobs.wait(job, clampWait(waitMs), ctx.mcpReq.signal);
        if (settled && job.error !== undefined) return fail(job.error);
        return report(settled ? (job.result as Task) : await deps.api.readTask(projectRoot, id));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
