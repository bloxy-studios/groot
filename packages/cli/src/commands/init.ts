/**
 * `groot init [dir]` — plant a new bun-first Turborepo workspace.
 *
 * The full pipeline per docs/architecture.md: resolve (flags + prompts) →
 * preflight → generate (official generators / direct writes) → stitch
 * (workspace coherence patches) → verify (structure + install + git), with
 * `--dry-run` stopping after preflight (docs/cli-spec.md#groot-init-dir).
 */
import { basename, relative, resolve } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../package.json";
import { bannerText } from "../banner.ts";
import { EXIT, GrootError } from "../engine/errors.ts";
import { generate } from "../engine/generate.ts";
import { MATRIX, SLOT_ORDER, YES_DEFAULTS } from "../engine/matrix.ts";
import {
  applyYesDefaults,
  buildPlan,
  describePlan,
  planToManifest,
  type SlotSelections,
  undecidedSlots,
  validateSelections,
} from "../engine/plan.ts";
import { resolveDirConflict, runPreflight } from "../engine/preflight.ts";
import { stitch } from "../engine/stitch.ts";
import type { DirConflictPolicy, Plan, PreflightCheck, Slot } from "../engine/types.ts";
import { verify } from "../engine/verify.ts";

const DIR_CONFLICT_POLICIES: readonly DirConflictPolicy[] = ["error", "merge", "increment"];

function parseDirConflict(value: string): DirConflictPolicy {
  if ((DIR_CONFLICT_POLICIES as readonly string[]).includes(value)) {
    return value as DirConflictPolicy;
  }
  throw new GrootError(
    `Invalid value for --dir-conflict: "${value}"`,
    EXIT.USAGE,
    `Valid policies: ${DIR_CONFLICT_POLICIES.join(" | ")}`,
  );
}

/** Prompt for every undecided slot. Exits 130 on cancel (nothing written). */
async function promptForSlots(selections: SlotSelections): Promise<Record<Slot, string>> {
  const resolved: SlotSelections = { ...selections };
  for (const slot of SLOT_ORDER) {
    if (resolved[slot] !== undefined) continue;
    const spec = MATRIX[slot];
    const answer = await p.select({
      message: `${spec.title}?`,
      options: [
        ...spec.choices.map((choice) => ({ value: choice.id as string, label: choice.label })),
        { value: "none", label: "Skip" },
      ],
      initialValue: YES_DEFAULTS[slot],
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled — nothing was written.");
      process.exit(EXIT.CANCELLED);
    }
    resolved[slot] = answer;
  }
  return resolved as Record<Slot, string>;
}

function reportChecks(checks: PreflightCheck[], toStderr: boolean): void {
  const write = toStderr ? console.error : console.log;
  for (const check of checks) {
    write(`${pc.green("✓")} ${check.name} ${pc.dim(check.detail)}`);
  }
}

async function runInit(args: {
  dir: string | undefined;
  name: string | undefined;
  web: string | undefined;
  mobile: string | undefined;
  api: string | undefined;
  backend: string | undefined;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  install: boolean;
  git: boolean;
  dirConflict: string;
  keepFailed: boolean;
  verbose: boolean;
}): Promise<void> {
  if (args.json && !args.dryRun) {
    throw new GrootError("--json currently requires --dry-run", EXIT.USAGE);
  }
  const dirConflict = parseDirConflict(args.dirConflict);

  const selections: SlotSelections = {
    web: args.web,
    mobile: args.mobile,
    api: args.api,
    backend: args.backend,
  };
  validateSelections(selections);

  const undecided = undecidedSlots(selections);
  const wantsPrompts = (undecided.length > 0 || args.dir === undefined) && !args.yes;
  const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  if (wantsPrompts && !isTTY) {
    throw new GrootError(
      "Interactive prompts need a TTY, and this environment doesn't have one.",
      EXIT.USAGE,
      "Pass --yes (accept defaults) or set a target dir plus every slot flag (--web/--mobile/--api/--backend).",
    );
  }

  let dir = args.dir;
  let resolvedSelections: Record<Slot, string>;

  if (wantsPrompts) {
    p.intro(bannerText(pkg.version));
    if (dir === undefined) {
      const answer = await p.text({
        message: "Where should groot plant your workspace?",
        placeholder: "./my-app",
        validate: (value) =>
          value === undefined || value.trim().length === 0 ? "A directory is required." : undefined,
      });
      if (p.isCancel(answer)) {
        p.cancel("Cancelled — nothing was written.");
        process.exit(EXIT.CANCELLED);
      }
      dir = answer;
    }
    resolvedSelections = await promptForSlots(selections);
  } else {
    if (dir === undefined) {
      throw new GrootError(
        "Target directory required.",
        EXIT.USAGE,
        "Example: groot init my-app --yes",
      );
    }
    resolvedSelections = applyYesDefaults(selections);
  }

  const requestedDir = resolve(process.cwd(), dir);
  const targetDir = await resolveDirConflict(requestedDir, dirConflict);
  const plan: Plan = buildPlan({
    name: args.name ?? basename(targetDir),
    targetDir,
    cliVersion: pkg.version,
    selections: resolvedSelections,
    options: {
      install: args.install,
      git: args.git,
      dirConflict,
      keepFailed: args.keepFailed,
      verbose: args.verbose,
    },
  });

  // Preflight (read-only in dry runs). In --json mode all diagnostics go to stderr
  // so stdout stays pure machine-readable output (docs/cli-spec.md#output-contract).
  const checks = await runPreflight(plan, { dryRun: args.dryRun });
  reportChecks(checks, args.json);
  if (targetDir !== requestedDir) {
    const note = `directory conflict: using ${targetDir} (increment policy)`;
    (args.json ? console.error : console.log)(`${pc.yellow("●")} ${note}`);
  }

  if (args.dryRun) {
    if (args.json) {
      console.log(JSON.stringify(planToManifest(plan), null, 2));
    } else {
      console.log();
      console.log(describePlan(plan));
      console.log();
      console.log(`${pc.yellow("●")} dry run — nothing was written.`);
    }
    return;
  }

  if (wantsPrompts) {
    p.note(describePlan(plan), "Your plan");
    const confirmed = await p.confirm({ message: "Plant it?" });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled — nothing was written.");
      process.exit(EXIT.CANCELLED);
    }
    p.outro("Planting…");
  } else {
    console.log();
    console.log(describePlan(plan));
    console.log();
  }

  // The pipeline: generate → stitch → verify (docs/architecture.md#pipeline).
  const step = (label: string): void => {
    console.log(`${pc.green("◇")} ${label}…`);
  };
  await generate(plan, { verbose: args.verbose, onStep: step });
  await stitch(plan, { onStep: step });
  const verifyNotes = await verify(plan, { verbose: args.verbose, onStep: step });

  printNextSteps(plan, verifyNotes);
}

function printNextSteps(plan: Plan, verifyNotes: string[]): void {
  const rel = relative(process.cwd(), plan.targetDir) || ".";
  console.log();
  console.log(pc.green(pc.bold("🌳 I am groot — your workspace is planted.")));
  const gitNote = verifyNotes.find((note) => note.includes("commit skipped"));
  if (gitNote !== undefined) console.log(`${pc.yellow("●")} ${gitNote}`);
  console.log();
  console.log("Next steps:");
  const steps: string[] = [`cd ${rel}`];
  if (!plan.options.install) steps.push("bun install");
  if (plan.scaffolds.some((scaffold) => scaffold.framework === "convex")) {
    steps.push(
      "bun run --cwd packages/backend setup   # Convex login + dev deployment (interactive)",
    );
  }
  steps.push("bun dev");
  steps.forEach((text, index) => {
    console.log(`  ${index + 1}. ${pc.cyan(text)}`);
  });
  console.log();
  console.log(`Docs: ${pc.cyan("https://github.com/bloxy-studios/groot")}`);
}

export const init = defineCommand({
  meta: {
    name: "init",
    description: "Plant a new bun-first Turborepo workspace",
  },
  args: {
    dir: { type: "positional", required: false, description: "Target directory" },
    name: { type: "string", description: "Workspace name (default: dir basename)" },
    web: { type: "string", description: "Web app: next | sveltekit | none" },
    mobile: { type: "string", description: "Mobile app: expo | none" },
    api: { type: "string", description: "API: elysia | hono | none" },
    backend: { type: "string", description: "Backend: convex | none" },
    yes: {
      type: "boolean",
      alias: "y",
      default: false,
      description: "Accept defaults for all unanswered prompts",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the resolved plan; write nothing",
    },
    json: {
      type: "boolean",
      default: false,
      description: "With --dry-run: machine-readable plan on stdout",
    },
    install: { type: "boolean", default: true, negativeDescription: "Skip root bun install" },
    git: { type: "boolean", default: true, negativeDescription: "Skip git init + initial commit" },
    "dir-conflict": {
      type: "string",
      default: "error",
      description: "Non-empty target policy: error | merge | increment",
    },
    "keep-failed": {
      type: "boolean",
      default: false,
      description: "Keep the target dir if a generator fails",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "Stream generator output instead of spinners",
    },
  },
  async run({ args }) {
    try {
      await runInit({
        dir: args.dir,
        name: args.name,
        web: args.web,
        mobile: args.mobile,
        api: args.api,
        backend: args.backend,
        yes: args.yes,
        dryRun: args["dry-run"],
        json: args.json,
        install: args.install,
        git: args.git,
        dirConflict: args["dir-conflict"],
        keepFailed: args["keep-failed"],
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
