#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { banner, scaffoldMatrixSummary } from "./banner.ts";
import { normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";

const main = defineCommand({
  meta: {
    name: "groot",
    version: pkg.version,
    description: pkg.description,
  },
  subCommands: { init, add, doctor },
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
