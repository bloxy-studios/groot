/**
 * `groot init [dir]` — plant a new bun-first Turborepo workspace.
 *
 * The full pipeline per docs/architecture.md: resolve (flags + prompts) →
 * preflight → generate (official generators / direct writes) → stitch
 * (workspace coherence patches) → verify (structure + install + git), with
 * `--dry-run` stopping after preflight (docs/cli-spec.md#groot-init-dir).
 */
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../package.json";
import { bannerText } from "../banner.ts";
import { EXIT, GrootError } from "../engine/errors.ts";
import { generate } from "../engine/generate.ts";
import {
  type GitHubPublishResult,
  gitIdentityPresent,
  hasCommits,
  publishToGitHub,
} from "../engine/github.ts";
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
import { applyPresetSelections, loadPreset } from "../engine/preset.ts";
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
  desktop: string | undefined;
  api: string | undefined;
  backend: string | undefined;
  preset: string | undefined;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  install: boolean;
  git: boolean;
  github: boolean;
  public: boolean;
  dirConflict: string;
  keepFailed: boolean;
  verbose: boolean;
}): Promise<void> {
  if (args.json && !args.dryRun) {
    throw new GrootError("--json currently requires --dry-run", EXIT.USAGE);
  }
  if (args.public && !args.github) {
    throw new GrootError(
      "--public only applies together with --github.",
      EXIT.USAGE,
      "Add --github to create and push the repository, or drop --public.",
    );
  }
  if (args.github && !args.git) {
    throw new GrootError(
      "--github needs the initial commit that --no-git skips.",
      EXIT.USAGE,
      "Drop --no-git (gh repo create --push hard-errors on a repo with no commits).",
    );
  }
  const dirConflict = parseDirConflict(args.dirConflict);

  const selections: SlotSelections = {
    web: args.web,
    mobile: args.mobile,
    desktop: args.desktop,
    api: args.api,
    backend: args.backend,
  };
  validateSelections(selections);

  // A preset decides every slot the flags left open (explicit flags win) —
  // its manifest validation guarantees the framework ids are known ones.
  // Diagnostics go to stderr in --json mode, like every other progress line.
  if (args.preset !== undefined) {
    const preset = await loadPreset(args.preset);
    const write = args.json ? console.error : console.log;
    const summary = SLOT_ORDER.map((slot) => `${slot} ${preset.selections[slot]}`).join(" · ");
    write(`${pc.green("✓")} preset ${preset.path} ${pc.dim(summary)}`);
    for (const warning of preset.warnings) {
      write(`${pc.yellow("●")} ${warning}`);
    }
    const merged = applyPresetSelections(selections, preset.selections);
    for (const slot of SLOT_ORDER) {
      selections[slot] = merged[slot];
    }
  }

  const undecided = undecidedSlots(selections);
  const wantsPrompts = (undecided.length > 0 || args.dir === undefined) && !args.yes;
  const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  if (wantsPrompts && !isTTY) {
    throw new GrootError(
      "Interactive prompts need a TTY, and this environment doesn't have one.",
      EXIT.USAGE,
      "Pass --yes (accept defaults) or set a target dir plus every slot flag (--web/--mobile/--desktop/--api/--backend).",
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

  // Composed once so every summary (dry-run, prompt confirm, plain) shows it.
  const githubSummaryLine = args.github
    ? `github     create ${args.public ? "public" : "private"} repo + push initial commit (gh)`
    : undefined;
  const planSummary =
    githubSummaryLine === undefined
      ? describePlan(plan)
      : `${describePlan(plan)}\n${githubSummaryLine}`;

  // The ordering fix (issue #44): --github hard-requires the commit it will
  // push, so its preconditions are usage errors BEFORE anything is generated
  // (and before the dry-run preview returns — both checks are read-only):
  // 1. a git identity, since verify's missing-identity downgrade would strand
  //    a valid-but-unpushable workspace against gh's zero-commit hard error;
  // 2. when merging onto an existing .git, at least one commit — verify skips
  //    its init+commit block for pre-existing repos, and `gh repo create
  //    --push` hard-errors on a commit-less one.
  if (args.github) {
    const gitCwd = existsSync(targetDir) ? targetDir : process.cwd();
    if (!(await gitIdentityPresent(gitCwd))) {
      throw new GrootError(
        "--github needs a git identity for the initial commit it pushes.",
        EXIT.USAGE,
        'Set one first: git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
      );
    }
    if (existsSync(join(targetDir, ".git")) && !(await hasCommits(targetDir))) {
      throw new GrootError(
        "--github targets an existing git repository that has no commits.",
        EXIT.USAGE,
        "gh repo create --push hard-errors on a commit-less repo — commit something there first, or drop --github.",
      );
    }
  }

  if (args.dryRun) {
    if (args.json) {
      console.log(JSON.stringify(planToManifest(plan), null, 2));
    } else {
      console.log();
      console.log(planSummary);
      console.log();
      console.log(`${pc.yellow("●")} dry run — nothing was written.`);
    }
    return;
  }

  if (wantsPrompts) {
    p.note(planSummary, "Your plan");
    const confirmed = await p.confirm({ message: "Plant it?" });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled — nothing was written.");
      process.exit(EXIT.CANCELLED);
    }
    p.outro("Planting…");
  } else {
    console.log();
    console.log(planSummary);
    console.log();
  }

  // The pipeline: generate → stitch → verify (docs/architecture.md#pipeline).
  const step = (label: string): void => {
    console.log(`${pc.green("◇")} ${label}…`);
  };
  await generate(plan, { verbose: args.verbose, onStep: step });
  await stitch(plan, { onStep: step });
  const verifyNotes = await verify(plan, { verbose: args.verbose, onStep: step });

  // After the initial commit: detect gh → auth → create + push. Degrades to
  // printed fallback steps, never a failure — the workspace itself is valid.
  let github: GitHubPublishResult | undefined;
  if (args.github) {
    step("Publishing to GitHub");
    github = await publishToGitHub({
      name: plan.name,
      targetDir: plan.targetDir,
      visibility: args.public ? "public" : "private",
    });
  }

  printNextSteps(plan, verifyNotes, github);
}

function printNextSteps(plan: Plan, verifyNotes: string[], github?: GitHubPublishResult): void {
  const rel = relative(process.cwd(), plan.targetDir) || ".";
  console.log();
  console.log(pc.green(pc.bold("🌳 I am groot — your workspace is planted.")));
  const gitNote = verifyNotes.find((note) => note.includes("commit skipped"));
  if (gitNote !== undefined) console.log(`${pc.yellow("●")} ${gitNote}`);
  if (github !== undefined) {
    console.log(
      github.status === "created"
        ? `${pc.green("✓")} GitHub: ${github.url ?? github.note}`
        : `${pc.yellow("●")} ${github.note}`,
    );
  }
  console.log();
  console.log("Next steps:");
  const steps: string[] = [`cd ${rel}`];
  if (!plan.options.install) steps.push("bun install");
  if (github !== undefined && github.status !== "created") {
    steps.push(...github.fallback);
  }
  if (plan.scaffolds.some((scaffold) => scaffold.framework === "convex")) {
    steps.push(
      "bun run --cwd packages/backend setup   # Convex login + dev deployment (interactive)",
    );
  }
  const supabase = plan.scaffolds.find((scaffold) => scaffold.framework === "supabase");
  if (supabase !== undefined) {
    steps.push(
      `bun run --cwd ${supabase.path} dev   # supabase start — local stack, needs Docker running`,
    );
  }
  const tauri = plan.scaffolds.find((scaffold) => scaffold.framework === "tauri");
  if (tauri !== undefined) {
    steps.push(
      `bun run --cwd ${tauri.path} tauri dev   # needs Rust — install via https://rustup.rs`,
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
    web: {
      type: "string",
      description:
        "Web app: next | sveltekit | tanstack-start | astro | react-router | nuxt | vite | none",
    },
    mobile: { type: "string", description: "Mobile app: expo | react-native | none" },
    desktop: { type: "string", description: "Desktop app: tauri | electron | none" },
    api: { type: "string", description: "API: elysia | hono | fastify | none" },
    backend: { type: "string", description: "Backend: convex | supabase | none" },
    preset: {
      type: "string",
      description:
        "Path to a groot.json (or a workspace containing one) used as the selections source",
    },
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
    github: {
      type: "boolean",
      default: false,
      description: "After the initial commit: create + push a GitHub repo via gh (private)",
    },
    public: {
      type: "boolean",
      default: false,
      description: "With --github: make the created repository public",
    },
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
        desktop: args.desktop,
        api: args.api,
        backend: args.backend,
        preset: args.preset,
        yes: args.yes,
        dryRun: args["dry-run"],
        json: args.json,
        install: args.install,
        git: args.git,
        github: args.github,
        public: args.public,
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
