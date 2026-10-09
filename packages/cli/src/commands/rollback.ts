/**
 * `groot rollback <operationId> [--dry-run] [--allow <class>...]` — undo an
 * operation's recorded changes in reverse order. A path is only restored or
 * deleted while it still has the content Groot recorded after applying it;
 * any later edit is a conflict, and with any conflict nothing changes
 * (GROOT_E_ROLLBACK_CONFLICT, exit 6). `--dry-run` previews every step's
 * restore/delete/conflict and the irreversible effects without touching
 * anything (and without the lock).
 *
 * Undoing a dependency change re-syncs node_modules with `bun install
 * --no-save`, held to the project policy like apply and resume: approvals are
 * per run (`--allow`, repeatable, comma lists), and a denial is returned as
 * blocked decisions naming the exact re-run — nothing is rolled back.
 */
import { defineCommand } from "citty";
import { GLOBAL_ARGS, requiredPositional, runV2Command } from "../cli/run.ts";
import { GrootV2Error } from "../core/errors.ts";
import { loadProjectPolicy, previewRollback, rollbackOperation } from "../core/executor/index.ts";
import { parseAllowFlags, policyBlocked, shellQuote } from "./apply.ts";
import { renderOperationResult, renderPreview, requireProjectRoot } from "./status.ts";

export const rollback = defineCommand({
  meta: {
    name: "rollback",
    description: "Undo an operation's recorded changes (never overwrites later edits)",
  },
  args: {
    operation: {
      type: "positional",
      required: false,
      description: "Operation id, see groot status (required)",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Preview what would be restored, deleted, or blocked; change nothing",
    },
    allow: {
      type: "string",
      description: "Approve an action class for this run (repeatable; comma lists accepted)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args, rawArgs }) {
    await runV2Command("rollback", { json: args.json, events: args.events }, async (ctx) => {
      const operationId = requiredPositional(
        args.operation,
        "Name the operation to roll back.",
        "groot rollback <operationId> [--dry-run] [--allow <class>...] (groot status lists them)",
      );
      const approvals = parseAllowFlags(rawArgs);
      const root = requireProjectRoot(ctx.cwd);
      if (args["dry-run"]) {
        const preview = await previewRollback(ctx, root, operationId);
        return {
          ok: true,
          data: preview,
          refs: { operationId: preview.operationId },
          warnings: preview.possible
            ? []
            : [`rollback would be refused: ${preview.conflicts.join(", ")} changed after apply`],
          human: () => renderPreview(preview),
        };
      }
      try {
        const result = await rollbackOperation(ctx, root, operationId, { approvals });
        return {
          ok: true,
          data: result,
          refs: { planId: result.planId, operationId: result.operationId },
          human: () => renderOperationResult(result, "Rolled back"),
        };
      } catch (error) {
        if (error instanceof GrootV2Error && error.id === "GROOT_E_POLICY_DENIED") {
          const rerun = `groot rollback ${shellQuote(operationId)}`;
          const policy = await loadProjectPolicy(root);
          return policyBlocked(error, rerun, { operationId }, policy, "rollback");
        }
        throw error;
      }
    });
  },
});
