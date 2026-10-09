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
import { GLOBAL_ARGS, repeatedFlag, runV2Command, stringFlag } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { recipeDescriptors } from "../core/capabilities/registry.ts";
import { GrootV2Error } from "../core/errors.ts";
import { writeFileAtomic } from "../core/fs/atomic.ts";
import { prettyJson } from "../core/json.ts";
import type { CapabilityRequestInput } from "../core/mcp/api.ts";

function applyHint(planId: string, steps: number): string {
  return steps === 0
    ? pc.green("Nothing to do — the project already has everything this plan would add.")
    : `${pc.cyan("Apply with:")} groot apply ${planId}`;
}

/** GROOT_E_UNKNOWN_CAPABILITY for recipe ids this build doesn't have, listing the ones it has. */
function unknownRecipes(
  ids: readonly string[],
  recipes: ReadonlyMap<string, string>,
): GrootV2Error {
  const alternatives = [...recipes.keys()].sort();
  const refusals = ids.map((id) => ({
    code: "unknown-recipe" as const,
    message: `Unknown recipe "${id}".`,
    alternatives,
  }));
  return new GrootV2Error(
    "GROOT_E_UNKNOWN_CAPABILITY",
    refusals.map((refusal) => refusal.message).join(" "),
    { hint: `Recipes in this build: ${alternatives.join(" · ")}.`, details: { refusals } },
  );
}

/**
 * Solver requests: every named capability, plus each `--recipe` (repeatable)
 * attached to the capability that recipe supplies (`recipes`: recipe id →
 * capability) — added first when it is a dependency nobody named, so a
 * blocked "choose with --recipe <id>" decision can always be followed by
 * appending that flag. A recipe id this build doesn't have is refused as
 * unknown wherever it appears, before it could be mistaken for a second
 * recipe of some capability.
 */
export function capabilityRequests(
  names: readonly string[],
  recipeIds: readonly string[],
  target: string | null,
  recipes: ReadonlyMap<string, string>,
): CapabilityRequestInput[] {
  const unknown = [...new Set(recipeIds.filter((id) => !recipes.has(id)))];
  if (unknown.length > 0) throw unknownRecipes(unknown, recipes);
  const requests: CapabilityRequestInput[] = names.map((capability) => ({
    capability,
    target,
    recipe: null,
  }));
  for (const recipe of recipeIds) {
    const capability = recipes.get(recipe) as string;
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
      // Checked in the body: a missing one is a usage envelope, not citty's usage text.
      type: "positional",
      required: false,
      description: "Capability id(s): auth, data, … (at least one)",
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
      const names = capabilityNames((args._ as string[] | undefined) ?? [args.capability ?? ""]);
      if (names.length === 0) {
        throw new GrootV2Error("GROOT_E_USAGE", "Name at least one capability to plan.", {
          hint: "Example: groot plan add auth --target api",
        });
      }
      const target = stringFlag(args.target, "target") ?? null;
      const out = stringFlag(args.out, "out");
      const api = createApi();
      const requests = capabilityRequests(
        names,
        repeatedFlag(rawArgs, "recipe"),
        target,
        new Map(recipeDescriptors().map((recipe) => [recipe.id, recipe.capability])),
      );
      const root = api.projectRoot(ctx.cwd);
      const plan = await api.planAdd(ctx, root, requests, { experimental: args.experimental });
      if (out !== undefined) writeFileAtomic(resolve(ctx.cwd, out), prettyJson(plan));
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
  args: { ...GLOBAL_ARGS },
  subCommands: { add, "context-sync": contextSync },
  // citty runs this when no subcommand is named (instead of failing with usage
  // text on stdout) — and after one that returns, which a v2 one never does.
  async run({ args }) {
    if (args._.length > 0) return;
    await runV2Command("plan", { json: args.json, events: args.events }, async () => {
      throw new GrootV2Error("GROOT_E_USAGE", "Name what to plan: add or context-sync.", {
        hint: "Usage: groot plan add <capability>... | groot plan context-sync",
      });
    });
  },
});
