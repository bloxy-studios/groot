/**
 * Operation tools. Applying, resuming, and rolling back run as background jobs
 * inside the server; each call waits at most 45 s and otherwise returns the
 * operation id with explicit polling instructions. The executor's journal is
 * the source of truth, so status survives client timeouts and restarts, and
 * re-applying a completed plan is a no-op (safe for client retries).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ActionClass } from "../contracts/common.ts";
import type { OperationResult, OperationState } from "../contracts/operation.ts";
import { GrootV2Error } from "../errors.ts";
import { createContext } from "../runtime.ts";
import type { ToolDeps } from "./deps.ts";
import { clampWait, type Job } from "./jobs.ts";
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
  .describe("How long to wait for completion in this call (default 20000, max 45000)");
const Summary = z.looseObject({ summary: z.string(), next: z.array(z.string()) });
const LINK_TIMEOUT_MS = 3000;

function compactState(state: OperationState): Record<string, unknown> {
  return {
    operationId: state.operationId,
    planId: state.planId,
    status: state.status,
    summary: state.summary,
    resumable: state.resumable,
    currentStep: state.currentStep,
    steps: state.steps.map(
      (step) =>
        `${step.id} ${step.status}${step.outcome ? ` (${step.outcome})` : ""}: ${step.description}`,
    ),
    error: state.error,
    evidence: state.evidence,
  };
}

/** The executor journals operation.started first — find the operation for a plan. */
async function linkOperation(
  deps: ToolDeps,
  root: string,
  planId: string,
  job: Job<unknown>,
): Promise<void> {
  const deadline = Date.now() + LINK_TIMEOUT_MS;
  while (job.operationId === null && Date.now() < deadline && !job.done) {
    const match = (await deps.api.listOperations(root).catch(() => [])).find(
      (state) => state.planId === planId,
    );
    if (match !== undefined) {
      job.operationId = match.operationId;
      return;
    }
    await Bun.sleep(100);
  }
}

function resultSummary(result: OperationResult): ToolResult {
  return ok({
    summary: result.alreadyApplied
      ? `Plan ${result.planId} was already applied by ${result.operationId}; nothing was executed again.`
      : `Operation ${result.operationId} ${result.status}: ${result.steps.filter((step) => step.status === "done").length}/${result.steps.length} step(s) done.`,
    next:
      result.status === "completed"
        ? [
            "Call verify_run (structural,build; add runtime,product-flow for live checks) to prove the change works.",
            ...result.nextSteps,
          ]
        : [`Call operation_status with operationId=${result.operationId}.`],
    operationId: result.operationId,
    state: result.status,
    alreadyApplied: result.alreadyApplied,
    steps: result.steps.map((step) => `${step.id} ${step.status}: ${step.description}`),
    evidence: result.evidence,
  });
}

async function settleOrPoll(
  deps: ToolDeps,
  job: Job<unknown>,
  waitMs: number,
  signal: AbortSignal,
  label: string,
): Promise<ToolResult> {
  const settled = await deps.jobs.wait(job, waitMs, signal);
  if (settled) {
    if (job.error !== undefined) return fail(job.error);
    return resultSummary(job.result as OperationResult);
  }
  return ok({
    summary: `${label} is still running${job.operationId ? ` as ${job.operationId}` : ""}.`,
    next: [
      job.operationId
        ? `Call operation_status with operationId=${job.operationId} and waitMs=45000 until it finishes.`
        : "Call operation_status (no id) to find the running operation.",
    ],
    operationId: job.operationId,
    state: "running",
    pollAfterMs: 5000,
  });
}

export function registerOperationTools(server: McpServer, deps: ToolDeps): void {
  const rootOf = (input: string | undefined): string => deps.api.projectRoot(input ?? deps.cwd);
  const background = (root: string, signal: AbortSignal) =>
    createContext({ cwd: root, signal, events: deps.events });

  server.registerTool(
    "operation_apply",
    {
      title: "Apply a plan",
      description:
        "Execute a plan from plan_add/plan_context_sync with journaled checkpoints. Refuses stale plans (files changed since planning) and action classes the project policy does not allow. Re-applying a completed plan does nothing. Returns within waitMs; long operations keep running — poll operation_status.",
      inputSchema: z.strictObject({
        root: Root,
        planId: z.string().describe("Plan id to execute"),
        allow: z
          .array(ActionClass)
          .optional()
          .describe("Extra action classes the user approved for this run"),
        waitMs: WaitMs,
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ root, planId, allow, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const plan = await deps.api.getPlan(projectRoot, planId);
        const job = deps.jobs.start(`apply:${plan.planId}`, plan.planId, (signal) =>
          deps.api.apply(background(projectRoot, signal), projectRoot, plan, allow ?? []),
        );
        await linkOperation(deps, projectRoot, plan.planId, job);
        return await settleOrPoll(
          deps,
          job,
          clampWait(waitMs),
          ctx.mcpReq.signal,
          `Plan ${plan.planId}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "operation_status",
    {
      title: "Operation status",
      description:
        "State of an operation (or, without an id, the most recent operations). With waitMs, waits for a running operation started by this server to finish.",
      inputSchema: z.strictObject({
        root: Root,
        operationId: z
          .string()
          .optional()
          .describe("Operation id (op_…); omit to list recent operations"),
        waitMs: WaitMs,
      }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, operationId, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        if (operationId === undefined) {
          const operations = (await deps.api.listOperations(projectRoot)).slice(0, 10);
          return ok({
            summary:
              operations.length === 0
                ? "No operations yet."
                : `${operations.length} recent operation(s); newest ${operations[0]?.operationId} is ${operations[0]?.status}.`,
            next: [],
            operations: operations.map(compactState),
          });
        }
        const job = deps.jobs.find(operationId);
        if (job !== undefined && !job.done && waitMs !== 0) {
          await deps.jobs.wait(job, clampWait(waitMs), ctx.mcpReq.signal);
        }
        const state = await deps.api.readOperation(projectRoot, operationId);
        return ok({
          summary: `Operation ${state.operationId} is ${state.status}: ${state.summary}.`,
          next:
            state.status === "running"
              ? [`Call operation_status with operationId=${state.operationId} and waitMs=45000.`]
              : state.status === "interrupted" || (state.status === "failed" && state.resumable)
                ? [
                    `Call operation_resume with operationId=${state.operationId}, or operation_rollback to undo.`,
                  ]
                : state.status === "completed"
                  ? ["Call verify_run to prove the change works."]
                  : [],
          operation: compactState(state),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "operation_cancel",
    {
      title: "Cancel an operation",
      description:
        "Cooperatively cancel an operation this server is running: it stops at the next checkpoint, terminates child processes, and stays resumable.",
      inputSchema: z.strictObject({
        root: Root,
        operationId: z.string().describe("Operation id to cancel"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ root, operationId }) => {
      try {
        const projectRoot = rootOf(root);
        const job = deps.jobs.find(operationId);
        if (deps.jobs.cancel(operationId) && job !== undefined) {
          await deps.jobs.wait(job, 15_000);
        } else {
          const state = await deps.api.readOperation(projectRoot, operationId);
          if (state.status === "running") {
            throw new GrootV2Error(
              "GROOT_E_BLOCKED",
              `Operation ${operationId} is running in another process; this server cannot stop it.`,
              { hint: "Stop it where it runs (Ctrl-C in that terminal); it will be resumable." },
            );
          }
        }
        const state = await deps.api.readOperation(projectRoot, operationId);
        return ok({
          summary: `Operation ${operationId} is ${state.status}.`,
          next: state.resumable
            ? [
                `Call operation_resume with operationId=${operationId} to continue, or operation_rollback.`,
              ]
            : [],
          operation: compactState(state),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "operation_resume",
    {
      title: "Resume an operation",
      description:
        "Continue an interrupted or failed operation from its journal: completed steps are skipped, the in-flight step is reconciled, pending steps re-check their preconditions. A non-idempotent command interrupted mid-flight needs retryStep or skipStep.",
      inputSchema: z.strictObject({
        root: Root,
        operationId: z.string(),
        retryStep: z.string().optional().describe("Re-run this interrupted non-idempotent step"),
        skipStep: z.string().optional().describe("Treat this interrupted step as done"),
        waitMs: WaitMs,
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ root, operationId, retryStep, skipStep, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const job = deps.jobs.start(`resume:${operationId}`, `resume:${operationId}`, (signal) =>
          deps.api.resume(background(projectRoot, signal), projectRoot, operationId, {
            retryStep,
            skipStep,
          }),
        );
        job.operationId = operationId;
        return await settleOrPoll(
          deps,
          job,
          clampWait(waitMs),
          ctx.mcpReq.signal,
          `Operation ${operationId}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "operation_rollback",
    {
      title: "Roll back an operation",
      description:
        "Preview (default) or execute recovery of an operation in reverse order. Files are restored or removed only if unchanged since groot wrote them; any later human edit makes the rollback refuse and change nothing. Irreversible effects are listed.",
      inputSchema: z.strictObject({
        root: Root,
        operationId: z.string(),
        execute: z
          .boolean()
          .optional()
          .describe("false (default) previews; true performs the rollback"),
        waitMs: WaitMs,
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ root, operationId, execute, waitMs }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        if (execute !== true) {
          const preview = await deps.api.previewRollback(
            background(projectRoot, ctx.mcpReq.signal),
            projectRoot,
            operationId,
          );
          return ok({
            summary: preview.possible
              ? `Rollback of ${operationId} is possible: ${preview.steps.length} step(s).`
              : `Rollback of ${operationId} is blocked by ${preview.conflicts.length} conflicting file(s).`,
            next: preview.possible
              ? [`Ask the user, then call operation_rollback with execute=true.`]
              : [],
            preview,
          });
        }
        const job = deps.jobs.start(
          `rollback:${operationId}`,
          `rollback:${operationId}`,
          (signal) => deps.api.rollback(background(projectRoot, signal), projectRoot, operationId),
        );
        job.operationId = operationId;
        return await settleOrPoll(
          deps,
          job,
          clampWait(waitMs),
          ctx.mcpReq.signal,
          `Rollback of ${operationId}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
