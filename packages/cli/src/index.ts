#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { banner, scaffoldMatrixSummary } from "./banner.ts";
import { normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { apply } from "./commands/apply.ts";
import { context } from "./commands/context.ts";
import { doctor } from "./commands/doctor.ts";
import { evidence } from "./commands/evidence.ts";
import { init } from "./commands/init.ts";
import { mcp } from "./commands/mcp.ts";
import { plan } from "./commands/plan.ts";
import { resume } from "./commands/resume.ts";
import { rollback } from "./commands/rollback.ts";
import { schema } from "./commands/schema.ts";
import { status } from "./commands/status.ts";
import { verify } from "./commands/verify.ts";
import { bootstrapCore } from "./core/bootstrap.ts";

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
    plan,
    apply,
    status,
    resume,
    rollback,
    verify,
    evidence,
    context,
    mcp,
    schema,
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

// Recipes and verification checkers are registered once for every surface.
bootstrapCore();

// `bun create groot my-app` passes a bare destination — route it to `init`.
runMain(main, { rawArgs: normalizeArgv(process.argv.slice(2)) });
