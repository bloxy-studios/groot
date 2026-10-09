/**
 * `groot schema [name]` — machine-contract discovery for agents and scripts:
 * every v2 contract (with its published JSON Schema URL), the capabilities and
 * recipes this build can plan, the v2 commands, stable error ids, and exit
 * codes. With a name, prints that contract's JSON Schema.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { listCapabilities, recipeDescriptors } from "../core/capabilities/registry.ts";
import { schemaUrl } from "../core/contracts/common.ts";
import { ERROR_IDS } from "../core/contracts/envelope.ts";
import { CONTRACTS, contractJsonSchema, findContract } from "../core/contracts/index.ts";
import { EXIT_V2, exitCodeFor, GrootV2Error } from "../core/errors.ts";

/** The v2 command surface (docs/v2-cli-spec.md); `--json` returns a result envelope for each. */
export const V2_COMMANDS: readonly { name: string; summary: string }[] = [
  {
    name: "inspect",
    summary: "Read-only discovery: facts with provenance, support level, unknowns",
  },
  { name: "adopt", summary: "Register an existing project (previewable; preserves layout)" },
  { name: "migrate", summary: "Explicit groot.json v1 → v2 migration (previewable)" },
  { name: "plan", summary: "Resolve an add/context-sync change into a concrete plan" },
  { name: "apply", summary: "Execute a plan with journaled checkpoints" },
  { name: "verify", summary: "Run structural/build/runtime/product-flow checks → evidence" },
  { name: "evidence", summary: "List or show stored evidence (addressable, redacted)" },
  { name: "status", summary: "Operations, resumability, lock holder, latest evidence" },
  { name: "resume", summary: "Continue an interrupted operation from its last checkpoint" },
  { name: "rollback", summary: "Preview or execute safe recovery of an operation" },
  {
    name: "context",
    summary: "Task-scoped project context; `context sync` manages agent instructions",
  },
  { name: "task", summary: "Create/run/resume/integrate bounded work for installed agents" },
  { name: "review", summary: "Review a task's change set (diff, ownership, acceptance, verdict)" },
  { name: "mcp", summary: "Serve the same operations as typed MCP tools over stdio" },
  { name: "schema", summary: "This discovery surface" },
];

export const schema = defineCommand({
  meta: {
    name: "schema",
    description: "List v2 machine contracts, capabilities, recipes, errors, and exit codes",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description: "Contract name (e.g. plan, evidence) — prints its JSON Schema",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("schema", { json: args.json, events: args.events }, async () => {
      if (args.name !== undefined) {
        const entry = findContract(args.name);
        if (entry === undefined) {
          throw new GrootV2Error("GROOT_E_NOT_FOUND", `No contract named "${args.name}".`, {
            hint: `Known contracts: ${CONTRACTS.map((contract) => contract.name).join(", ")}`,
          });
        }
        const jsonSchema = contractJsonSchema(entry);
        return {
          ok: true,
          data: jsonSchema,
          human: () => console.log(JSON.stringify(jsonSchema, null, 2)),
        };
      }
      const data = {
        contracts: CONTRACTS.map((entry) => ({
          name: entry.name,
          title: entry.title,
          description: entry.description,
          url: schemaUrl(entry.name),
        })),
        commands: V2_COMMANDS,
        capabilities: listCapabilities(),
        recipes: recipeDescriptors(),
        errors: ERROR_IDS.map((id) => ({ id, exitCode: exitCodeFor(id) })),
        exitCodes: EXIT_V2,
      };
      return {
        ok: true,
        data,
        human: () => {
          console.log(pc.bold("Contracts") + pc.dim("  (groot schema <name> prints one)"));
          for (const entry of data.contracts) {
            console.log(`  ${entry.name.padEnd(20)} ${entry.description}`);
          }
          console.log();
          console.log(pc.bold("Capabilities"));
          for (const capability of data.capabilities) {
            const recipes =
              capability.recipes.length > 0
                ? capability.recipes.join(", ")
                : pc.dim("no recipes in this build");
            console.log(`  ${capability.id.padEnd(20)} ${capability.title} — ${recipes}`);
          }
          console.log();
          console.log(pc.bold("Exit codes"));
          for (const [name, code] of Object.entries(EXIT_V2)) {
            console.log(`  ${String(code).padStart(3)}  ${name.toLowerCase()}`);
          }
        },
      };
    });
  },
});
