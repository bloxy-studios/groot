/**
 * `groot adopt [dir] [--dry-run]` — register an existing Bun/TypeScript
 * project with Groot while preserving its layout (core/planner/adopt.ts).
 *
 * --dry-run prints the plan — every action with its path and kind, the
 * exact file previews, ownership rules, preconditions, assumptions, and
 * recovery — and saves it (core/executor savePlan) so `groot apply <planId>`
 * can execute exactly what was reviewed. Without --dry-run the plan is
 * applied through the executor under the default policy. With --json, the
 * envelope's `data` is the OperationPlan (dry run) or the OperationResult.
 *
 * The plan rendering and dry-run/apply flow here are shared with
 * `groot migrate` (same shape, different planner).
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { DEFAULT_POLICY } from "../core/contracts/blueprint.ts";
import type { OperationResult } from "../core/contracts/operation.ts";
import type { OperationPlan, PlannedAction } from "../core/contracts/plan.ts";
import { GrootV2Error } from "../core/errors.ts";
import { applyPlan, savePlan } from "../core/executor/index.ts";
import { planAdopt } from "../core/planner/adopt.ts";
import type { CoreContext } from "../core/runtime.ts";

const MAX_PREVIEW_LINES = 120;

export const PLAN_COMMAND_ARGS = {
  dir: {
    type: "positional",
    required: false,
    description: "Project directory (default: the current directory — no walk-up)",
  },
  "dry-run": {
    type: "boolean",
    default: false,
    description:
      "Print and save the plan without changing anything (apply later: groot apply <planId>)",
  },
  ...GLOBAL_ARGS,
} as const;

function actionVerb(action: PlannedAction): string {
  if (action.type === "file.write") {
    return action.expect.state === "absent"
      ? "create"
      : action.expect.state === "sha256"
        ? "replace"
        : "write";
  }
  return action.type;
}

function actionTarget(action: PlannedAction): string {
  if ("path" in action) return action.path;
  if (action.type === "file.move") return `${action.from} → ${action.to}`;
  return "";
}

function renderActions(plan: OperationPlan): string[] {
  return [
    pc.bold("actions"),
    ...plan.actions.map(
      (action) =>
        `  ${action.id}  ${actionVerb(action).padEnd(8)} ${actionTarget(action).padEnd(18)} ${pc.dim(action.classes.join(","))}  ${action.description}`,
    ),
  ];
}

function renderPreviews(plan: OperationPlan): string[] {
  const lines: string[] = [];
  for (const action of plan.actions) {
    if (action.type !== "file.write") continue;
    const content = action.content.replace(/\n$/, "").split("\n");
    lines.push("", pc.bold(`preview: ${action.path}`) + pc.dim(`  (${action.sha256})`));
    lines.push(...content.slice(0, MAX_PREVIEW_LINES).map((line) => `  ${pc.dim("│")} ${line}`));
    if (content.length > MAX_PREVIEW_LINES) {
      lines.push(
        `  ${pc.dim(`│ … ${content.length - MAX_PREVIEW_LINES} more line(s) — see --json`)}`,
      );
    }
  }
  return lines;
}

function renderPolicy(plan: OperationPlan): string[] {
  const preconditions = plan.preconditions.map((entry) => {
    if (entry.type === "path")
      return `${entry.path} ${entry.expect.state === "sha256" ? "unchanged" : entry.expect.state}${entry.dirty ? " (dirty)" : ""}`;
    if (entry.type === "manifest") {
      return `registration ${entry.state === "absent" ? "none" : entry.state}`;
    }
    return entry.type === "toolchain" ? `${entry.id} available` : `${entry.path} fresh`;
  });
  return [
    "",
    pc.bold("ownership"),
    ...plan.ownership.map(
      (rule) => `  ${rule.owner.padEnd(6)} ${rule.path} ${pc.dim(`— ${rule.note}`)}`,
    ),
    "",
    `${pc.bold("preconditions")}  ${preconditions.join(" · ")}`,
    "",
    pc.bold("assumptions"),
    ...plan.assumptions.map((text) => `  · ${text}`),
    "",
    `${pc.bold("recovery")}  ${plan.recovery.mode} — ${plan.recovery.summary}`,
  ];
}

/** The full human rendering of a plan (stdout). */
export function renderPlan(plan: OperationPlan, savedTo: string | null): string[] {
  return [
    `${pc.green("◇")} ${pc.bold(plan.planId)} — ${plan.summary}`,
    `  ${pc.dim("root")} ${plan.project.root}`,
    "",
    ...renderActions(plan),
    ...renderPreviews(plan),
    ...renderPolicy(plan),
    "",
    savedTo === null
      ? pc.yellow("plan not saved (see warning)")
      : `${pc.bold("saved")}  ${savedTo} — apply with: ${pc.cyan(`groot apply ${plan.planId}`)}`,
  ];
}

/**
 * TEMPORARY (until core/executor is integrated): its stub throws
 * GROOT_E_INTERNAL "… is not integrated yet". A dry run still returns the
 * plan in that case — with a warning — so previews work before integration;
 * every other failure propagates unchanged.
 */
function isExecutorPending(error: unknown): boolean {
  return (
    error instanceof GrootV2Error &&
    error.id === "GROOT_E_INTERNAL" &&
    /not integrated/.test(error.message)
  );
}

async function savePlanForApply(
  plan: OperationPlan,
): Promise<{ savedTo: string | null; warnings: string[] }> {
  try {
    return { savedTo: await savePlan(plan.project.root, plan), warnings: [] };
  } catch (error) {
    if (!isExecutorPending(error)) throw error;
    return {
      savedTo: null,
      warnings: [
        `The plan was not saved: the executor is not integrated in this build, so groot apply ${plan.planId} cannot run it yet.`,
      ],
    };
  }
}

function appliedResult(plan: OperationPlan, result: OperationResult): CommandResult {
  if (result.status !== "completed" && result.error !== null) {
    throw new GrootV2Error(result.error.id, result.error.message, {
      hint: result.error.hint ?? undefined,
      details: {
        ...(result.error.details ?? {}),
        operationId: result.operationId,
        status: result.status,
      },
    });
  }
  return {
    ok: result.status === "completed",
    data: result,
    refs: { planId: plan.planId, operationId: result.operationId, evidence: result.evidence },
    human: () => {
      const verb = result.alreadyApplied ? "already applied" : result.status;
      console.log(
        `${pc.green("◇")} ${plan.summary} ${pc.dim(`(${verb}, operation ${result.operationId})`)}`,
      );
      for (const step of result.nextSteps) console.log(`  ${pc.cyan("next:")} ${step}`);
    },
  };
}

/** Plan, then either preview + save (--dry-run) or apply under the default policy. */
export async function runRegistrationCommand(
  ctx: CoreContext,
  options: {
    readonly command: string;
    readonly dryRun: boolean;
    readonly plan: () => Promise<OperationPlan>;
  },
): Promise<CommandResult> {
  const plan = await options.plan();
  if (options.dryRun) {
    const { savedTo, warnings } = await savePlanForApply(plan);
    return {
      ok: true,
      data: plan,
      warnings,
      refs: { planId: plan.planId },
      human: () => {
        for (const line of renderPlan(plan, savedTo)) console.log(line);
      },
    };
  }
  const result = await applyPlan(ctx, {
    plan,
    root: plan.project.root,
    policy: DEFAULT_POLICY,
    command: options.command,
  });
  return appliedResult(plan, result);
}

export const adopt = defineCommand({
  meta: {
    name: "adopt",
    description: "Register an existing Bun/TypeScript project with groot, preserving its layout",
  },
  args: PLAN_COMMAND_ARGS,
  async run({ args }) {
    await runV2Command("adopt", { json: args.json, events: args.events }, (ctx) =>
      runRegistrationCommand(ctx, {
        command: "adopt",
        dryRun: args["dry-run"],
        plan: () => planAdopt(ctx, args.dir ?? "."),
      }),
    );
  },
});
