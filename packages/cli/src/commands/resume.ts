/**
 * `groot resume <operationId>` — continue an interrupted, crashed, or failed
 * operation from its last journal checkpoint. Completed steps are never
 * repeated; the step that was in flight is reconciled first. A step that is
 * not safe to repeat blindly is returned as a blocked decision (exit 7) that
 * names both resolutions: `--retry-step <id>` or `--skip-step <id>`.
 *
 * The steps still to run are held to the project policy again, like apply:
 * approvals are per run, so `--allow <class>` (repeatable, comma lists) is
 * needed again for classes the policy does not allow, and a denial is
 * returned as blocked decisions naming the exact re-run.
 */
import { defineCommand } from "citty";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type { ErrorInfo } from "../core/contracts/envelope.ts";
import { EXIT_V2, GrootV2Error } from "../core/errors.ts";
import { loadProjectPolicy, resumeOperation } from "../core/executor/index.ts";
import { parseAllowFlags, policyBlocked, shellQuote } from "./apply.ts";
import { renderOperationResult, requireProjectRoot } from "./status.ts";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stepDecision(
  error: GrootV2Error,
  operationId: string,
  stepId: string,
): CommandResult & { readonly error: ErrorInfo } {
  // Generators name what a retry removes from their destination first.
  const removes = ((error.details?.removes ?? []) as unknown[]).map(String);
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
            label:
              removes.length > 0
                ? `It did not — remove ${removes.join(", ")} and run it again`
                : "It did not — run it again",
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
    allow: {
      type: "string",
      description: "Approve an action class for this run (repeatable; comma lists accepted)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("resume", { json: args.json, events: args.events }, async (ctx) => {
      const retryStep = optionalString(args["retry-step"]);
      const skipStep = optionalString(args["skip-step"]);
      if (retryStep !== undefined && skipStep !== undefined) {
        throw new GrootV2Error(
          "GROOT_E_USAGE",
          "Use either --retry-step or --skip-step, not both.",
        );
      }
      const approvals = parseAllowFlags(rawArgs);
      const root = requireProjectRoot(ctx.cwd);
      const policy = await loadProjectPolicy(root);
      try {
        const result = await resumeOperation(ctx, root, args.operation, {
          retryStep,
          skipStep,
          policy: policy.policy,
          approvals,
        });
        return {
          ok: true,
          data: result,
          refs: { planId: result.planId, operationId: result.operationId },
          human: () => renderOperationResult(result, "Resumed"),
        };
      } catch (error) {
        if (error instanceof GrootV2Error && error.id === "GROOT_E_POLICY_DENIED") {
          const step =
            retryStep !== undefined
              ? ` --retry-step ${shellQuote(retryStep)}`
              : skipStep !== undefined
                ? ` --skip-step ${shellQuote(skipStep)}`
                : "";
          const rerun = `groot resume ${shellQuote(args.operation)}${step}`;
          return policyBlocked(error, rerun, { operationId: args.operation }, policy);
        }
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
