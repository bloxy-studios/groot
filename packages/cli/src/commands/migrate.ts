/**
 * `groot migrate [dir] [--dry-run]` — the explicit, previewable groot.json
 * version 1 → 2 migration (core/planner/migrate.ts). Same shape as
 * `groot adopt`: --dry-run prints and saves the plan (exact groot.json and
 * groot.lock.json previews); without it the executor applies the plan. A
 * workspace that is not version 1 is refused with GROOT_E_USAGE explaining
 * its registration state; nothing is ever migrated implicitly.
 */
import { defineCommand } from "citty";
import { runV2Command } from "../cli/run.ts";
import { planMigrate } from "../core/planner/migrate.ts";
import { PLAN_COMMAND_ARGS, runRegistrationCommand } from "./adopt.ts";

export const migrate = defineCommand({
  meta: {
    name: "migrate",
    description: "Upgrade a groot v1 workspace's groot.json to version 2 (previewable, explicit)",
  },
  args: PLAN_COMMAND_ARGS,
  async run({ args }) {
    await runV2Command("migrate", { json: args.json, events: args.events }, (ctx) =>
      runRegistrationCommand(ctx, {
        command: "migrate",
        dryRun: args["dry-run"],
        plan: () => planMigrate(ctx, args.dir ?? "."),
      }),
    );
  },
});
