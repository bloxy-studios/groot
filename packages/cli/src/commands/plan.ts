/**
 * `groot plan add <capability>...` and `groot plan context-sync` — resolve a
 * change into a concrete, previewable plan (docs/v2-cli-spec.md#groot-plan-add)
 * and save it under .groot/plans/. Nothing in the project changes until
 * `groot apply <planId>`.
 */
import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { renderPlan } from "../cli/render.ts";
import { GLOBAL_ARGS, repeatedFlag, runV2Command } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { getRecipe } from "../core/capabilities/registry.ts";
import { GrootV2Error } from "../core/errors.ts";
import { writeFileAtomic } from "../core/fs/atomic.ts";
import { prettyJson } from "../core/json.ts";
import type { CapabilityRequestInput } from "../core/mcp/api.ts";

function applyHint(planId: string, steps: number): string {
  return steps === 0
    ? pc.green("Nothing to do — the project already has everything this plan would add.")
    : `${pc.cyan("Apply with:")} groot apply ${planId}`;
}

/**
 * Solver requests: every named capability, plus each `--recipe` (repeatable)
 * attached to the capability that recipe supplies — added first when it is a
 * dependency nobody named, so a blocked "choose with --recipe <id>" decision
 * can always be followed by appending that flag. An unknown recipe id stays
 * on the first capability, where the solver refuses it with alternatives.
 */
export function capabilityRequests(
  names: readonly string[],
  recipeIds: readonly string[],
  target: string | null,
  capabilityOf: (recipeId: string) => string | undefined,
): CapabilityRequestInput[] {
  const requests: CapabilityRequestInput[] = names.map((capability) => ({
    capability,
    target,
    recipe: null,
  }));
  for (const recipe of recipeIds) {
    const capability = capabilityOf(recipe) ?? requests[0]?.capability;
    if (capability === undefined) continue;
    const index = requests.findIndex((request) => request.capability === capability);
    if (index === -1) {
      requests.unshift({ capability, target, recipe });
      continue;
    }
    const current = requests[index] as CapabilityRequestInput;
    if (current.recipe != null && current.recipe !== recipe) {
      throw new GrootV2Error(
        "GROOT_E_USAGE",
        `Two recipes for ${capability}: ${current.recipe} and ${recipe}.`,
        { hint: "Pass one --recipe per capability." },
      );
    }
    requests[index] = { ...current, recipe };
  }
  return requests;
}

/** Positional capability names; commas allowed ("auth,data"). */
function capabilityNames(positionals: readonly string[]): string[] {
  return positionals
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const add = defineCommand({
  meta: {
    name: "add",
    description: "Plan adding capabilities (e.g. auth, data) to a registered project",
  },
  args: {
    capability: {
      type: "positional",
      required: true,
      description: "Capability id(s): auth, data, …",
    },
    target: { type: "string", description: "App id or path when several apps fit" },
    recipe: {
      type: "string",
      description:
        "Recipe id when several recipes fit (repeatable; applies to the capability it supplies)",
    },
    experimental: {
      type: "boolean",
      default: false,
      description: "Allow recipes that are not certified",
    },
    out: { type: "string", description: "Also write the plan JSON to this file" },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("plan add", { json: args.json, events: args.events }, async (ctx) => {
      const names = capabilityNames((args._ as string[] | undefined) ?? [args.capability]);
      if (names.length === 0) {
        throw new GrootV2Error("GROOT_E_USAGE", "Name at least one capability to plan.", {
          hint: "Example: groot plan add auth --target api",
        });
      }
      const api = createApi();
      const requests = capabilityRequests(
        names,
        repeatedFlag(rawArgs, "recipe"),
        args.target ?? null,
        (id) => getRecipe(id)?.descriptor.capability,
      );
      const root = api.projectRoot(ctx.cwd);
      const plan = await api.planAdd(ctx, root, requests, { experimental: args.experimental });
      if (args.out !== undefined) writeFileAtomic(resolve(ctx.cwd, args.out), prettyJson(plan));
      return {
        ok: true,
        data: plan,
        refs: { planId: plan.planId },
        human: () => {
          console.log(renderPlan(plan));
          console.log();
          console.log(applyHint(plan.planId, plan.actions.length));
        },
      };
    });
  },
});

const contextSync = defineCommand({
  meta: {
    name: "context-sync",
    description: "Plan refreshing groot-managed AGENTS.md/CLAUDE.md sections and skills",
  },
  args: {
    "skip-conflicts": {
      type: "boolean",
      default: false,
      description: "Plan everything else and report conflicting files",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command(
      "plan context-sync",
      { json: args.json, events: args.events },
      async (ctx) => {
        const api = createApi();
        const root = api.projectRoot(ctx.cwd);
        const result = await api.planContextSync(ctx, root, args["skip-conflicts"]);
        return {
          ok: true,
          data: { plan: result.plan, changes: result.changes, warnings: result.warnings },
          warnings: result.warnings,
          refs: { planId: result.plan.planId },
          human: () => {
            for (const change of result.changes) {
              console.log(`  ${change.action.padEnd(13)} ${change.path}  ${pc.dim(change.reason)}`);
            }
            console.log();
            console.log(applyHint(result.plan.planId, result.plan.actions.length));
          },
        };
      },
    );
  },
});

export const plan = defineCommand({
  meta: { name: "plan", description: "Resolve a change into a concrete, previewable plan" },
  subCommands: { add, "context-sync": contextSync },
});
