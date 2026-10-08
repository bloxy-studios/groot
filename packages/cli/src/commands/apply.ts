/**
 * `groot apply <plan>` — execute a plan (a plan JSON file, or the id of a plan
 * saved under .groot/plans/) as a journaled, resumable operation.
 *
 * Policy comes from groot.json when it is a valid v2 blueprint, else the
 * default policy. `--allow <class>` approves extra action classes for this run
 * only; it is repeatable and accepts comma lists. citty keeps only the LAST
 * value of a repeated flag, so the occurrences are collected from the raw
 * args here. A policy denial is returned as blocked decisions (exit 7), one
 * per denied class, each naming the exact re-run that resolves it.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { BlueprintV2, DEFAULT_POLICY, type Policy } from "../core/contracts/blueprint.ts";
import { ActionClass } from "../core/contracts/common.ts";
import type { BlockedDecision, ErrorInfo } from "../core/contracts/envelope.ts";
import type { OperationPlan } from "../core/contracts/plan.ts";
import { EXIT_V2, GrootV2Error } from "../core/errors.ts";
import {
  applyPlan,
  findProjectRoot,
  isPlanId,
  loadPlanFile,
  loadSavedPlan,
} from "../core/executor/index.ts";
import { renderOperationResult } from "./status.ts";

function usage(message: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_USAGE", message, {
    hint: `Action classes: ${ActionClass.options.join(", ")}.`,
  });
}

/**
 * Every `--allow` value in raw args (`--allow a --allow b`, `--allow=a,b`),
 * validated against the action-class enum and de-duplicated.
 */
export function parseAllowFlags(rawArgs: readonly string[]): ActionClass[] {
  const values: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index] as string;
    if (arg === "--") break;
    if (arg === "--allow") {
      const value = rawArgs[index + 1];
      if (value === undefined || value.startsWith("-"))
        throw usage("--allow needs an action class.");
      values.push(value);
      index++;
    } else if (arg.startsWith("--allow=")) {
      values.push(arg.slice("--allow=".length));
    }
  }
  const classes = new Set<ActionClass>();
  for (const name of values.flatMap((value) => value.split(",")).map((part) => part.trim())) {
    if (name === "") continue;
    const parsed = ActionClass.safeParse(name);
    if (!parsed.success) throw usage(`--allow ${name}: not an action class.`);
    classes.add(parsed.data);
  }
  return [...classes];
}

/** A plan file path, or a saved plan id when no such file exists. */
async function resolvePlan(cwd: string, ref: string): Promise<OperationPlan> {
  const path = resolve(cwd, ref);
  if (isPlanId(ref) && !existsSync(path)) {
    return loadSavedPlan(findProjectRoot(cwd) ?? cwd, ref);
  }
  return loadPlanFile(path);
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The project to apply to: the enclosing project (or cwd itself) when it is
 * the plan's root; otherwise the enclosing project, which the executor then
 * refuses as a different root.
 */
function projectRootFor(cwd: string, plan: OperationPlan): string {
  const found = findProjectRoot(cwd);
  for (const candidate of [found, cwd]) {
    if (candidate !== null && sameDirectory(candidate, plan.project.root)) return candidate;
  }
  return found ?? cwd;
}

export interface PolicySource {
  readonly policy: Policy;
  readonly source: "groot.json" | "default";
}

/** groot.json's policy when it is a valid v2 blueprint, else DEFAULT_POLICY. */
export function projectPolicy(root: string): PolicySource {
  try {
    const parsed = BlueprintV2.safeParse(
      JSON.parse(readFileSync(join(root, "groot.json"), "utf8")),
    );
    if (parsed.success) return { policy: parsed.data.policy, source: "groot.json" };
  } catch {
    // absent or unreadable groot.json → default policy
  }
  return { policy: DEFAULT_POLICY, source: "default" };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function policyDecision(cls: string, planRef: string, policy: Policy): BlockedDecision {
  const rerun = `groot apply ${shellQuote(planRef)} --allow ${cls}`;
  const external = cls === "external";
  return {
    id: `policy.${cls}`,
    kind: "policy",
    question: external
      ? "The plan changes provider accounts (external effects). Approve them for this run?"
      : `The plan needs "${cls}" actions, which the project policy does not allow. Approve them for this run?`,
    options: [
      {
        id: "allow",
        label: `Allow ${cls} for this run`,
        effect: "Applies the plan; groot.json's policy stays as it is.",
        recommended: false,
      },
      { id: "keep", label: "Keep the policy", effect: "Nothing is applied.", recommended: true },
    ],
    resolveWith:
      external && policy.external === "deny"
        ? `set "policy.external" to "ask" in groot.json, then ${rerun}`
        : rerun,
  };
}

function policyBlocked(
  error: GrootV2Error,
  planRef: string,
  plan: OperationPlan,
  policy: PolicySource,
): CommandResult & { readonly error: ErrorInfo } {
  const denied = ((error.details?.denied ?? []) as unknown[]).map(String);
  return {
    ok: false,
    data: { planId: plan.planId, denied, policySource: policy.source },
    blocked: denied.map((cls) => policyDecision(cls, planRef, policy.policy)),
    refs: { planId: plan.planId },
    exitCode: EXIT_V2.BLOCKED,
    error: error.toInfo(),
    human: () =>
      console.log(
        `${pc.yellow("●")} Nothing applied — the ${policy.source} policy does not allow: ${denied.join(", ")}.`,
      ),
  };
}

export const apply = defineCommand({
  meta: {
    name: "apply",
    description: "Apply a plan as a journaled, resumable operation (plan file or saved plan id)",
  },
  args: {
    plan: {
      type: "positional",
      required: true,
      description: "Plan JSON file, or the id of a plan saved under .groot/plans/",
    },
    allow: {
      type: "string",
      description: "Approve an action class for this run (repeatable; comma lists accepted)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("apply", { json: args.json, events: args.events }, async (ctx) => {
      const approvals = parseAllowFlags(rawArgs);
      const plan = await resolvePlan(ctx.cwd, args.plan);
      const root = projectRootFor(ctx.cwd, plan);
      const policy = projectPolicy(root);
      try {
        const result = await applyPlan(ctx, {
          plan,
          root,
          policy: policy.policy,
          approvals,
          command: "apply",
        });
        return {
          ok: true,
          data: result,
          refs: { planId: result.planId, operationId: result.operationId },
          human: () => renderOperationResult(result, "Applied"),
        };
      } catch (error) {
        if (error instanceof GrootV2Error && error.id === "GROOT_E_POLICY_DENIED") {
          return policyBlocked(error, args.plan, plan, policy);
        }
        throw error;
      }
    });
  },
});
