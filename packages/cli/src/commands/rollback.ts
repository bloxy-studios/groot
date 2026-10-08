/**
 * `groot rollback <operationId> [--dry-run]` — undo an operation's recorded
 * changes in reverse order. A path is only restored or deleted while it still
 * has the content Groot recorded after applying it; any later edit is a
 * conflict, and with any conflict nothing changes (GROOT_E_ROLLBACK_CONFLICT,
 * exit 6). `--dry-run` previews every step's restore/delete/conflict and the
 * irreversible effects without touching anything (and without the lock).
 */
import { defineCommand } from "citty";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { previewRollback, rollbackOperation } from "../core/executor/index.ts";
import { renderOperationResult, renderPreview, requireProjectRoot } from "./status.ts";

export const rollback = defineCommand({
  meta: {
    name: "rollback",
    description: "Undo an operation's recorded changes (never overwrites later edits)",
  },
  args: {
    operation: {
      type: "positional",
      required: true,
      description: "Operation id (see groot status)",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Preview what would be restored, deleted, or blocked; change nothing",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("rollback", { json: args.json, events: args.events }, async (ctx) => {
      const root = requireProjectRoot(ctx.cwd);
      if (args["dry-run"]) {
        const preview = await previewRollback(ctx, root, args.operation);
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
      const result = await rollbackOperation(ctx, root, args.operation);
      return {
        ok: true,
        data: result,
        refs: { planId: result.planId, operationId: result.operationId },
        human: () => renderOperationResult(result, "Rolled back"),
      };
    });
  },
});
