/**
 * `groot apply <plan>` — execute a plan (a plan JSON file, or the id of a plan
 * saved under .groot/plans/) as a journaled, resumable operation.
 *
 * Policy comes from groot.json: its v2 policy, or the default policy for a
 * project without a v2 blueprint; an invalid or unreadable groot.json fails
 * closed (GROOT_E_INVALID_DOCUMENT). `--allow <class>` approves extra action
 * classes for this run only; it is repeatable and accepts comma lists. citty
 * keeps only the LAST value of a repeated flag, so the occurrences are
 * collected from the raw args here. A policy denial is returned as blocked
 * decisions (exit 7), one per denied class, each naming the exact re-run that
 * resolves it.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { type CommandResult, GLOBAL_ARGS, requiredPositional, runV2Command } from "../cli/run.ts";
import type { Policy } from "../core/contracts/blueprint.ts";
import { ActionClass } from "../core/contracts/common.ts";
import type { BlockedDecision, ErrorInfo } from "../core/contracts/envelope.ts";
import type { OperationPlan } from "../core/contracts/plan.ts";
import { EXIT_V2, GrootV2Error } from "../core/errors.ts";
import {
  applyPlan,
  findProjectRoot,
  isPlanId,
  loadPlanFile,
  loadProjectPolicy,
  loadSavedPlan,
  type PolicySource,
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

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** What a policy denial stopped: applying or resuming a plan, or a rollback's compensating install. */
export type Refused = "apply" | "resume" | "rollback";

const REFUSED_WORDING: Record<Refused, { needs: string; allow: string; nothing: string }> = {
  apply: { needs: "The plan needs", allow: "Applies the plan", nothing: "applied" },
  resume: { needs: "The plan needs", allow: "Continues the operation", nothing: "resumed" },
  rollback: {
    needs: "Rolling back re-syncs node_modules with bun install --no-save, so it needs",
    allow: "Rolls the operation back",
    nothing: "rolled back",
  },
};

/** `rerunBase` is the command that was refused ("groot apply plan.json"); --allow is appended. */
function policyDecision(
  cls: string,
  rerunBase: string,
  policy: Policy,
  refused: Refused,
): BlockedDecision {
  const rerun = `${rerunBase} --allow ${cls}`;
  const external = cls === "external";
  const wording = REFUSED_WORDING[refused];
  return {
    id: `policy.${cls}`,
    kind: "policy",
    question: external
      ? "The plan changes provider accounts (external effects). Approve them for this run?"
      : `${wording.needs} "${cls}" actions, which the project policy does not allow. Approve them for this run?`,
    options: [
      {
        id: "allow",
        label: `Allow ${cls} for this run`,
        effect: `${wording.allow}; groot.json's policy stays as it is.`,
        recommended: false,
      },
      {
        id: "keep",
        label: "Keep the policy",
        effect: `Nothing is ${wording.nothing}.`,
        recommended: true,
      },
    ],
    resolveWith:
      external && policy.external === "deny"
        ? `set "policy.external" to "ask" in groot.json, then ${rerun}`
        : rerun,
  };
}

/**
 * A GROOT_E_POLICY_DENIED as blocked decisions (exit 7), one per denied class.
 * `rerunBase` is the refused command line; `subject` identifies what was
 * refused (`planId` or `operationId`) in data and refs; `refused` words the
 * decisions (default: applying a plan, or resuming an operation).
 */
export function policyBlocked(
  error: GrootV2Error,
  rerunBase: string,
  subject: { readonly planId: string } | { readonly operationId: string },
  policy: PolicySource,
  refused: Refused = "planId" in subject ? "apply" : "resume",
): CommandResult & { readonly error: ErrorInfo } {
  const denied = ((error.details?.denied ?? []) as unknown[]).map(String);
  return {
    ok: false,
    data: { ...subject, denied, policySource: policy.source },
    blocked: denied.map((cls) => policyDecision(cls, rerunBase, policy.policy, refused)),
    refs: subject,
    exitCode: EXIT_V2.BLOCKED,
    error: error.toInfo(),
    human: () =>
      console.log(
        `${pc.yellow("●")} Nothing ${REFUSED_WORDING[refused].nothing} — the ${policy.source} policy does not allow: ${denied.join(", ")}.`,
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
      required: false,
      description: "Plan JSON file, or the id of a plan saved under .groot/plans/ (required)",
    },
    allow: {
      type: "string",
      description: "Approve an action class for this run (repeatable; comma lists accepted)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("apply", { json: args.json, events: args.events }, async (ctx) => {
      const ref = requiredPositional(
        args.plan,
        "Name the plan to apply: a plan file or the id of a saved plan.",
        "groot apply <plan-file | planId> [--allow <class>...]",
      );
      const approvals = parseAllowFlags(rawArgs);
      const plan = await resolvePlan(ctx.cwd, ref);
      const root = projectRootFor(ctx.cwd, plan);
      const policy = await loadProjectPolicy(root);
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
          const rerun = `groot apply ${shellQuote(ref)}`;
          return policyBlocked(error, rerun, { planId: plan.planId }, policy);
        }
        throw error;
      }
    });
  },
});
