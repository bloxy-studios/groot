#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { banner, scaffoldMatrixSummary } from "./banner.ts";
import { normalizeArgv } from "./cli-compat.ts";
import { init } from "./commands/init.ts";

const SPEC_URL = "https://github.com/bloxy-studios/groot/blob/main/docs/cli-spec.md";
const ROADMAP_URL = "https://github.com/bloxy-studios/groot/blob/main/docs/roadmap.md";

/**
 * `add` and `doctor` are specified in docs/cli-spec.md and land in v0.3
 * (see docs/roadmap.md). The stubs exist so early adopters get a helpful
 * pointer instead of an unknown-command error.
 */
function comingSoon(command: string, version: string): never {
  console.log(banner(pkg.version));
  console.log();
  console.log(`${pc.yellow("●")} ${pc.bold(`groot ${command}`)} arrives in ${pc.bold(version)}.`);
  console.log(`  Planned matrix — ${scaffoldMatrixSummary()}`);
  console.log();
  console.log(`  Spec:    ${pc.cyan(SPEC_URL)}`);
  console.log(`  Roadmap: ${pc.cyan(ROADMAP_URL)}`);
  process.exit(0);
}

const add = defineCommand({
  meta: {
    name: "add",
    description: "Grow an existing groot workspace with another scaffold (arrives in v0.3)",
  },
  run() {
    comingSoon("add", "v0.3");
  },
});

const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Check the health of a groot workspace (arrives in v0.3)",
  },
  run() {
    comingSoon("doctor", "v0.3");
  },
});

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
