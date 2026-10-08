/**
 * `groot context [--task "<goal>"]` returns task-scoped project knowledge;
 * `groot context sync [--dry-run] [--skip-conflicts]` plans and applies the
 * managed instruction projection (docs/v2-cli-spec.md#groot-context).
 * `sync` is a positional action (not a citty subcommand) so the parent never
 * runs twice and `--task` values are never mistaken for subcommands.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { GrootV2Error } from "../core/errors.ts";

export const context = defineCommand({
  meta: {
    name: "context",
    description: "Task-scoped project context; `context sync` manages agent instructions",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "sync — refresh managed AGENTS.md/CLAUDE.md sections and skills",
    },
    task: { type: "string", description: "What you are about to do (scopes the context)" },
    "dry-run": { type: "boolean", default: false, description: "With sync: preview only" },
    "skip-conflicts": {
      type: "boolean",
      default: false,
      description: "With sync: sync everything else, report conflicts",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    const action = args.action;
    await runV2Command(
      action === "sync" ? "context sync" : "context",
      { json: args.json, events: args.events },
      async (ctx) => {
        const api = createApi();
        const root = api.projectRoot(ctx.cwd);
        if (action !== undefined && action !== "sync") {
          throw new GrootV2Error("GROOT_E_USAGE", `Unknown context action "${action}".`, {
            hint: 'Use `groot context --task "…"` or `groot context sync`.',
          });
        }
        if (action === "sync") {
          const synced = await api.planContextSync(ctx, root, args["skip-conflicts"]);
          const conflicts = synced.changes.filter((change) => change.action === "conflict");
          if (args["dry-run"] || synced.plan.actions.length === 0) {
            return {
              ok: true,
              data: { plan: synced.plan, changes: synced.changes, applied: null },
              warnings: synced.warnings,
              refs: { planId: synced.plan.planId },
              human: () => {
                for (const change of synced.changes) {
                  console.log(
                    `  ${change.action.padEnd(13)} ${change.path}  ${pc.dim(change.reason)}`,
                  );
                  if (change.diff !== "")
                    console.log(
                      pc.dim(
                        change.diff
                          .split("\n")
                          .slice(0, 20)
                          .map((line) => `      ${line}`)
                          .join("\n"),
                      ),
                    );
                }
                if (synced.plan.actions.length === 0)
                  console.log(pc.green("Agent context is already in sync."));
                else
                  console.log(
                    `\n${pc.cyan("Apply with:")} groot context sync   ${pc.dim(`(or groot apply ${synced.plan.planId})`)}`,
                  );
              },
            };
          }
          const applied = await api.apply(ctx, root, synced.plan, []);
          return {
            ok: true,
            data: { plan: synced.plan, changes: synced.changes, applied },
            warnings: [
              ...synced.warnings,
              ...conflicts.map((change) => `skipped ${change.path}: ${change.reason}`),
            ],
            refs: { planId: synced.plan.planId, operationId: applied.operationId },
            human: () => {
              for (const change of synced.changes)
                console.log(`  ${change.action.padEnd(13)} ${change.path}`);
              console.log(pc.green(`\nSynced (operation ${applied.operationId}).`));
            },
          };
        }
        const result = await api.context(ctx, root, args.task ?? null);
        return {
          ok: true,
          data: result,
          human: () => {
            console.log(
              pc.bold(`${result.project.name}`) +
                pc.dim(
                  `  ${result.project.topology}${result.project.registered ? "" : " · not registered"}`,
                ),
            );
            for (const unit of result.units) {
              console.log(
                `  ${unit.path.padEnd(16)} ${unit.kind}${unit.framework ? `/${unit.framework}` : ""}  ${pc.dim(`${Math.round(unit.relevance * 100)}% — ${unit.why}`)}`,
              );
            }
            if (result.environment.length > 0) {
              console.log(pc.bold("\nEnvironment (names only)"));
              for (const entry of result.environment)
                console.log(
                  `  ${entry.name} → ${entry.storage} (${entry.scope}/${entry.sensitivity})`,
                );
            }
            if (result.acceptance.length > 0) {
              console.log(pc.bold("\nAcceptance"));
              for (const entry of result.acceptance) console.log(`  ${entry.command}`);
            }
            if (result.gaps.length > 0) {
              console.log(pc.bold("\nKnown gaps"));
              for (const gap of result.gaps) console.log(`  • ${gap}`);
            }
          },
        };
      },
    );
  },
});
