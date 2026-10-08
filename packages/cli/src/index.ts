#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { banner, scaffoldMatrixSummary } from "./banner.ts";
import { normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { apply } from "./commands/apply.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
import { resume } from "./commands/resume.ts";
import { rollback } from "./commands/rollback.ts";
import { status } from "./commands/status.ts";

const main = defineCommand({
  meta: {
    name: "groot",
    version: pkg.version,
    description: pkg.description,
  },
  subCommands: { init, add, doctor, apply, resume, rollback, status },
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
