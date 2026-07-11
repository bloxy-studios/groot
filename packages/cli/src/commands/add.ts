/**
 * `groot add <framework>` — grow an existing groot workspace with one more
 * scaffold (docs/cli-spec.md#groot-add-scaffold-v03).
 *
 * Thin flag layer over engine/add.ts: load the manifest (walk-up), resolve the
 * new scaffold (occupancy rule, fresh destination, port warnings), then run
 * grow → stitch → verify for just that scaffold. `--dry-run` prints the
 * would-be scaffold and the groot.json change without writing anything;
 * `--dry-run --json` emits the would-be manifest on pure stdout.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import {
  buildAddPlan,
  executeAdd,
  readRootPackageName,
  resolveAddScaffold,
} from "../engine/add.ts";
import { EXIT, GrootError } from "../engine/errors.ts";
import { loadManifest } from "../engine/manifest.ts";
import { describeScaffold, planToManifest } from "../engine/plan.ts";
import type { Plan, PlannedScaffold } from "../engine/types.ts";

async function runAdd(args: {
  framework: string;
  path: string | undefined;
  install: boolean;
  keepFailed: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
}): Promise<void> {
  if (args.json && !args.dryRun) {
    throw new GrootError("--json currently requires --dry-run", EXIT.USAGE);
  }
  const loaded = await loadManifest(process.cwd());
  const { scaffold, warnings } = await resolveAddScaffold(
    loaded.manifest,
    loaded.workspaceRoot,
    args.framework,
    args.path,
  );
  const rootName = await readRootPackageName(loaded.workspaceRoot);
  const plan = buildAddPlan(loaded, scaffold, rootName, {
    install: args.install,
    keepFailed: args.keepFailed,
    verbose: args.verbose,
  });

  // In --json mode all diagnostics go to stderr so stdout stays pure
  // machine-readable output (docs/cli-spec.md#output-contract).
  const write = args.json ? console.error : console.log;
  write();
  write(`${pc.dim("workspace")}  ${loaded.workspaceRoot}`);
  write(`${pc.dim("growing")}    ${describeScaffold(scaffold)}`);
  write();
  for (const warning of warnings) {
    write(`${pc.yellow("●")} ${warning}`);
  }

  if (args.dryRun) {
    if (args.json) {
      // The manifest as groot.json would read after the add — the same
      // versioned schema `init --dry-run --json` emits; the new scaffold is
      // the final entry.
      console.log(JSON.stringify(planToManifest(plan), null, 2));
      return;
    }
    console.log(
      `groot.json gains one scaffold (${loaded.manifest.scaffolds.length} → ${plan.scaffolds.length}):`,
    );
    for (const line of JSON.stringify(scaffold, null, 2).split("\n")) {
      console.log(pc.green(`+ ${line}`));
    }
    console.log();
    console.log(`${pc.yellow("●")} dry run — nothing was written.`);
    return;
  }

  const step = (label: string): void => {
    console.log(`${pc.green("◇")} ${label}…`);
  };
  await executeAdd(plan, scaffold, { verbose: args.verbose, onStep: step });
  printNextSteps(plan, scaffold);
}

function printNextSteps(plan: Plan, scaffold: PlannedScaffold): void {
  console.log();
  console.log(pc.green(pc.bold(`🌿 I am groot — ${scaffold.path} has grown.`)));
  console.log();
  console.log("Next steps:");
  const steps: string[] = [];
  if (!plan.options.install) steps.push("bun install");
  if (scaffold.framework === "convex") {
    steps.push(
      `bun run --cwd ${scaffold.path} setup   # Convex login + dev deployment (interactive)`,
    );
  }
  steps.push("bun dev");
  steps.forEach((text, index) => {
    console.log(`  ${index + 1}. ${pc.cyan(text)}`);
  });
}

export const add = defineCommand({
  meta: {
    name: "add",
    description: "Grow an existing groot workspace with another scaffold",
  },
  args: {
    framework: {
      type: "positional",
      required: true,
      description: "Scaffold to grow: next | sveltekit | expo | elysia | hono | convex",
    },
    path: {
      type: "string",
      description:
        "Destination relative to the workspace root — a fresh apps/<name> or packages/<name> (default: the framework's standard path)",
    },
    install: {
      type: "boolean",
      default: true,
      negativeDescription: "Skip the root bun install after growing",
    },
    "keep-failed": {
      type: "boolean",
      default: false,
      description: "Keep the new scaffold directory if its generator fails",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the would-be scaffold and groot.json change; write nothing",
    },
    json: {
      type: "boolean",
      default: false,
      description: "With --dry-run: the would-be groot.json (manifest schema) on stdout",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "Stream generator output instead of progress lines",
    },
  },
  async run({ args }) {
    try {
      await runAdd({
        framework: args.framework,
        path: args.path,
        install: args.install,
        keepFailed: args["keep-failed"],
        dryRun: args["dry-run"],
        json: args.json,
        verbose: args.verbose,
      });
    } catch (error) {
      if (error instanceof GrootError) {
        console.error(`${pc.red("groot error:")} ${error.message}`);
        if (error.hint !== undefined) console.error(`  ${pc.dim(error.hint)}`);
        process.exit(error.exitCode);
      }
      throw error;
    }
  },
});
