/**
 * `groot resume <operationId>` — continue an interrupted, crashed, or failed
 * operation from its last journal checkpoint. Completed steps are never
 * repeated; the step that was in flight is reconciled first. A step that is
 * not safe to repeat blindly is returned as a blocked decision (exit 7) that
 * names both resolutions: `--retry-step <id>` or `--skip-step <id>`.
 */
import { defineCommand } from "citty";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type { ErrorInfo } from "../core/contracts/envelope.ts";
import { EXIT_V2, GrootV2Error } from "../core/errors.ts";
import { resumeOperation } from "../core/executor/index.ts";
import { renderOperationResult, requireProjectRoot } from "./status.ts";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stepDecision(
  error: GrootV2Error,
  operationId: string,
  stepId: string,
): CommandResult & { readonly error: ErrorInfo } {
  return {
    ok: false,
    data: { operationId, stepId },
    blocked: [
      {
        id: `resume.${stepId}`,
        kind: "decision",
        question: `${error.message} Did it take effect?`,
        options: [
          {
            id: "retry",
            label: "It did not — run it again",
            effect: `groot resume ${operationId} --retry-step ${stepId}`,
            recommended: false,
          },
          {
            id: "skip",
            label: "It did — keep its result and continue",
            effect: `groot resume ${operationId} --skip-step ${stepId}`,
            recommended: false,
          },
        ],
        resolveWith: `groot resume ${operationId} --retry-step ${stepId} | --skip-step ${stepId}`,
      },
    ],
    refs: { operationId },
    exitCode: EXIT_V2.BLOCKED,
    error: error.toInfo(),
  };
}

export const resume = defineCommand({
  meta: {
    name: "resume",
    description: "Continue an interrupted operation from its last checkpoint",
  },
  args: {
    operation: {
      type: "positional",
      required: true,
      description: "Operation id (see groot status)",
    },
    "retry-step": {
      type: "string",
      description: "Re-run the interrupted step even though it may not be safe to repeat",
    },
    "skip-step": {
      type: "string",
      description: "Mark the interrupted step done without running it (its effect is in place)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("resume", { json: args.json, events: args.events }, async (ctx) => {
      const retryStep = optionalString(args["retry-step"]);
      const skipStep = optionalString(args["skip-step"]);
      if (retryStep !== undefined && skipStep !== undefined) {
        throw new GrootV2Error(
          "GROOT_E_USAGE",
          "Use either --retry-step or --skip-step, not both.",
        );
      }
      const root = requireProjectRoot(ctx.cwd);
      try {
        const result = await resumeOperation(ctx, root, args.operation, { retryStep, skipStep });
        return {
          ok: true,
          data: result,
          refs: { planId: result.planId, operationId: result.operationId },
          human: () => renderOperationResult(result, "Resumed"),
        };
      } catch (error) {
        const stepId = error instanceof GrootV2Error ? error.details?.stepId : undefined;
        if (
          error instanceof GrootV2Error &&
          error.details?.gate === "interrupted-step" &&
          typeof stepId === "string"
        ) {
          return stepDecision(error, args.operation, stepId);
        }
        throw error;
      }
    });
  },
});
