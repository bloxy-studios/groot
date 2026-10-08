/**
 * `groot status [operationId]` — read-only view of operations: id, status,
 * intent, steps done/total, resumability, and the writer-lock holder when
 * one is held. Takes no lock. Also hosts the human renderers the other
 * operation commands (apply/resume/rollback) share.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type {
  OperationResult,
  OperationState,
  RollbackPreview,
  StepState,
} from "../core/contracts/operation.ts";
import { GrootV2Error } from "../core/errors.ts";
import {
  findProjectRoot,
  isHolderLive,
  type LockHolderInfo,
  listOperations,
  readLockHolder,
  readOperation,
} from "../core/executor/index.ts";

const STEP_ICON: Record<StepState["status"], string> = {
  pending: pc.dim("○"),
  running: pc.yellow("◐"),
  done: pc.green("✓"),
  failed: pc.red("✗"),
  "rolled-back": pc.cyan("↺"),
};

/** Root of the project containing `cwd`, or GROOT_E_NOT_A_PROJECT. */
export function requireProjectRoot(cwd: string): string {
  const root = findProjectRoot(cwd);
  if (root === null) {
    throw new GrootV2Error(
      "GROOT_E_NOT_A_PROJECT",
      `No groot project found from ${cwd} upward (no groot.json or .groot/).`,
      { hint: "Run this inside a project that groot has planned or applied changes for." },
    );
  }
  return root;
}

export function renderSteps(steps: readonly StepState[]): void {
  for (const step of steps) {
    const outcome =
      step.outcome === null || step.outcome === "applied" ? "" : pc.dim(` (${step.outcome})`);
    console.log(`  ${STEP_ICON[step.status]} ${step.id} ${step.description}${outcome}`);
  }
}

export function renderOperationResult(result: OperationResult, verb: string): void {
  if (result.alreadyApplied) {
    console.log(
      `${pc.green("✓")} Already applied by ${pc.bold(result.operationId)} — nothing to do.`,
    );
  } else {
    console.log(
      `${pc.green("✓")} ${verb} ${pc.bold(result.operationId)} (${result.planId}) — ${result.status}`,
    );
    renderSteps(result.steps);
  }
  for (const next of result.nextSteps) console.log(`  ${pc.dim("next:")} ${next}`);
}

export function renderPreview(preview: RollbackPreview): void {
  const verdict = preview.possible
    ? pc.green("rollback is possible")
    : pc.red(`rollback is blocked by ${preview.conflicts.length} conflict(s)`);
  console.log(`${pc.bold(preview.operationId)} — ${verdict}`);
  for (const step of preview.steps) {
    const paths = step.paths.length > 0 ? ` ${step.paths.join(", ")}` : "";
    const label = step.action === "conflict" ? pc.red(step.action) : step.action;
    console.log(`  ${step.stepId} ${label}${paths} ${pc.dim(`— ${step.reason}`)}`);
  }
  for (const entry of preview.irreversible) console.log(`  ${pc.yellow("irreversible:")} ${entry}`);
  for (const limit of preview.limits) console.log(`  ${pc.dim("limit:")} ${limit}`);
}

export interface OperationSummary {
  readonly id: string;
  readonly status: OperationState["status"];
  readonly intent: string;
  readonly summary: string;
  readonly steps: { readonly done: number; readonly total: number };
  readonly resumable: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function summarize(state: OperationState): OperationSummary {
  return {
    id: state.operationId,
    status: state.status,
    intent: state.intent.type,
    summary: state.summary,
    steps: {
      done: state.steps.filter((step) => step.status === "done").length,
      total: state.steps.length,
    },
    resumable: state.resumable,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

function lockView(holder: LockHolderInfo | null): (LockHolderInfo & { live: boolean }) | null {
  return holder === null ? null : { ...holder, live: isHolderLive(holder) };
}

function renderLock(lock: ReturnType<typeof lockView>): void {
  if (lock === null) return;
  const state = lock.live ? pc.yellow("held") : pc.dim("stale (holder gone)");
  console.log(
    `${pc.dim("lock:")} ${state} by ${lock.command} (pid ${lock.pid} on ${lock.host}${lock.operationId === null ? "" : `, ${lock.operationId}`})`,
  );
}

function renderList(
  operations: readonly OperationSummary[],
  lock: ReturnType<typeof lockView>,
): void {
  renderLock(lock);
  if (operations.length === 0) {
    console.log(pc.dim("No operations yet."));
    return;
  }
  for (const op of operations) {
    const resumable = op.resumable ? pc.yellow(" resumable") : "";
    console.log(
      `${pc.bold(op.id)}  ${op.status}${resumable}  ${op.intent}  ${op.steps.done}/${op.steps.total} steps  ${pc.dim(op.summary)}`,
    );
  }
}

function renderOne(state: OperationState, lock: ReturnType<typeof lockView>): void {
  renderLock(lock);
  const resumable = state.resumable ? pc.yellow(" (resumable)") : "";
  console.log(`${pc.bold(state.operationId)} ${state.status}${resumable} — ${state.summary}`);
  console.log(`  ${pc.dim("plan:")} ${state.planId}  ${pc.dim("intent:")} ${state.intent.type}`);
  renderSteps(state.steps);
  if (state.error !== null) console.log(`  ${pc.red("error:")} ${state.error.message}`);
  if (state.resumable) console.log(`  ${pc.dim("next:")} groot resume ${state.operationId}`);
}

export const status = defineCommand({
  meta: {
    name: "status",
    description: "Show operations (status, steps, resumability) and the writer lock",
  },
  args: {
    operation: {
      type: "positional",
      required: false,
      description: "Operation id (default: list every operation, newest first)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("status", { json: args.json, events: args.events }, async (ctx) => {
      const root = requireProjectRoot(ctx.cwd);
      const lock = lockView(readLockHolder(root));
      if (typeof args.operation === "string" && args.operation !== "") {
        const state = await readOperation(root, args.operation);
        return {
          ok: true,
          data: { operation: state, lock },
          refs: { planId: state.planId, operationId: state.operationId },
          human: () => renderOne(state, lock),
        };
      }
      const operations = (await listOperations(root)).map(summarize);
      return {
        ok: true,
        data: { root, operations, lock },
        human: () => renderList(operations, lock),
      };
    });
  },
});
