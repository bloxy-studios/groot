#!/usr/bin/env bun
import { type ArgsDef, type CommandDef, defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { banner, scaffoldMatrixSummary } from "./banner.ts";
import { normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";

/**
 * A v2 command, imported only when it is resolved — when it runs, or when
 * `groot --help` lists it — so the v1 commands, `--version`, and
 * `bun create groot <dir>` never load the v2 core. Recipes and verification
 * checkers are registered once, just before a v2 command (or one of its
 * subcommands) runs.
 */
function v2Command<T extends ArgsDef>(
  load: () => Promise<CommandDef<T>>,
): () => Promise<CommandDef<T>> {
  return async () => {
    const command = await load();
    return {
      ...command,
      async setup(context) {
        const { bootstrapCore } = await import("./core/bootstrap.ts");
        bootstrapCore();
        await command.setup?.(context);
      },
    };
  };
}

const main = defineCommand({
  meta: {
    name: "groot",
    version: pkg.version,
    description: pkg.description,
  },
  subCommands: {
    init,
    add,
    doctor,
    inspect: v2Command(() => import("./commands/inspect.ts").then((m) => m.inspect)),
    adopt: v2Command(() => import("./commands/adopt.ts").then((m) => m.adopt)),
    migrate: v2Command(() => import("./commands/migrate.ts").then((m) => m.migrate)),
    plan: v2Command(() => import("./commands/plan.ts").then((m) => m.plan)),
    apply: v2Command(() => import("./commands/apply.ts").then((m) => m.apply)),
    status: v2Command(() => import("./commands/status.ts").then((m) => m.status)),
    resume: v2Command(() => import("./commands/resume.ts").then((m) => m.resume)),
    rollback: v2Command(() => import("./commands/rollback.ts").then((m) => m.rollback)),
    verify: v2Command(() => import("./commands/verify.ts").then((m) => m.verify)),
    evidence: v2Command(() => import("./commands/evidence.ts").then((m) => m.evidence)),
    context: v2Command(() => import("./commands/context.ts").then((m) => m.context)),
    task: v2Command(() => import("./commands/task.ts").then((m) => m.task)),
    review: v2Command(() => import("./commands/review.ts").then((m) => m.review)),
    mcp: v2Command(() => import("./commands/mcp.ts").then((m) => m.mcp)),
    schema: v2Command(() => import("./commands/schema.ts").then((m) => m.schema)),
  },
  run({ args }) {
    // Bare invocation: show the banner and point at help.
    if (args._.length === 0) {
      console.log(banner(pkg.version));
      console.log();
      console.log(`  ${pc.dim("Scaffolds:")} ${scaffoldMatrixSummary()}`);
      console.log(`  ${pc.dim("Run")} ${pc.bold("groot --help")} ${pc.dim("for commands.")}`);
    }
  },
});

// `bun create groot my-app` passes a bare destination — route it to `init`.
runMain(main, { rawArgs: normalizeArgv(process.argv.slice(2)) });
