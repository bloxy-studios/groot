/**
 * `groot inspect [dir]` — read-only discovery (docs/v2-architecture.md#concepts).
 *
 * The directory (default: cwd) is the project root — no walk-up. With --json,
 * stdout carries one result envelope whose `data` is the ProjectObservation
 * (schemas/v2/project.schema.json). Exit 0 whenever inspection itself
 * succeeded — even for inspect-only or unsupported projects: support level is
 * data to act on, not a failure. Environment files are reported by variable
 * NAME only; values are never read into the report.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type { ProjectObservation, ProjectUnit } from "../core/contracts/project.ts";
import { inspect as inspectProject } from "../core/discovery/index.ts";

const MAX_ENV_NAMES = 8;

function registrationLine(observation: ProjectObservation): string {
  const { registration } = observation;
  switch (registration.status) {
    case "unregistered":
      return `not registered ${pc.dim("— preview adoption: groot adopt --dry-run")}`;
    case "v1":
      return `version 1 ${pc.dim("— preview the upgrade: groot migrate --dry-run")}`;
    case "v2":
      return "registered (version 2)";
    case "unsupported-version":
      return pc.yellow(`version ${registration.version ?? "?"} — not readable by this groot`);
    case "invalid":
      return pc.red(`invalid — ${registration.error ?? "unreadable"}`);
  }
}

function supportLines(observation: ProjectObservation): string[] {
  const { support } = observation;
  if (support.level === "certified") {
    return [`${pc.green("✓ certified")} ${pc.dim("— groot can adopt and change this project")}`];
  }
  const label =
    support.level === "unsupported" ? pc.red("✗ unsupported") : pc.yellow("● inspect-only");
  return [
    label,
    ...support.reasons.map((reason) => `              · ${reason}`),
    ...(support.nextStep === null ? [] : [`              ${pc.cyan("next:")} ${support.nextStep}`]),
  ];
}

function gitLine(observation: ProjectObservation): string {
  const { git } = observation;
  if (git.vcs === "none") return pc.dim("not a git repository");
  const at = `${git.branch ?? "(detached)"} @ ${git.head?.slice(0, 7) ?? "(no commits)"}`;
  if (!git.dirty) return `${at} · clean`;
  return `${at} · dirty: ${git.staged.length} staged, ${git.unstaged.length} unstaged, ${git.untracked.length} untracked`;
}

function confidence(level: string): string {
  return level === "certain" || level === "high" ? "" : pc.dim(` (${level})`);
}

function unitLines(unit: ProjectUnit): string[] {
  const framework = unit.framework.value;
  const parts = [
    `${unit.kind.value}${confidence(unit.kind.confidence)}`,
    framework === null
      ? null
      : `${framework.id}${framework.version === null ? "" : ` ${framework.version}`}`,
    `${unit.runtime.value}${confidence(unit.runtime.confidence)}`,
    unit.entry.value === null
      ? null
      : `entry ${unit.entry.value}${confidence(unit.entry.confidence)}`,
    ...unit.ports.slice(0, 1).map((port) => `port ${port.value}${confidence(port.confidence)}`),
  ].filter((part): part is string => part !== null);
  const lines = [`  ${pc.bold(unit.path)}  ${parts.join(" · ")}`];
  const byFile = new Map<string, string[]>();
  for (const variable of unit.envVariables) {
    byFile.set(variable.file, [...(byFile.get(variable.file) ?? []), variable.name]);
  }
  for (const [file, names] of byFile) {
    const shown = names.slice(0, MAX_ENV_NAMES).join(", ");
    const more = names.length > MAX_ENV_NAMES ? ` +${names.length - MAX_ENV_NAMES}` : "";
    lines.push(`     ${pc.dim("env")} ${file}: ${shown}${more} ${pc.dim("(names only)")}`);
  }
  return lines;
}

function agentFileSummary(observation: ProjectObservation): string {
  if (observation.agentFiles.length === 0) return pc.dim("none");
  return observation.agentFiles
    .map((file) => {
      const edited = file.managedRegions.filter((region) => !region.intact).length;
      if (file.managedRegions.length === 0) return file.path;
      const state = edited === 0 ? "intact" : pc.yellow(`${edited} hand-edited`);
      return `${file.path} (${file.managedRegions.length} groot region(s), ${state})`;
    })
    .join(", ");
}

/** Compact human report (stdout). */
export function renderObservation(observation: ProjectObservation): string[] {
  const toolchains = observation.toolchains
    .map((tool) => (tool.available ? `${tool.id} ${tool.version ?? "?"}` : pc.dim(`${tool.id} ✗`)))
    .join(" · ");
  const capabilities = observation.capabilities
    .map(({ value }) => `${value.capability}: ${value.provider} (${value.unit})`)
    .join(" · ");
  const lines = [
    `${pc.bold("groot inspect")}  ${observation.root}`,
    `  project     ${observation.name.value ?? "?"} · ${observation.topology.value} · ${observation.packageManager.value}${confidence(observation.packageManager.confidence)}`,
    `  git         ${gitLine(observation)}`,
    `  groot.json  ${registrationLine(observation)}`,
    `  support     ${supportLines(observation).join("\n")}`,
    "",
    pc.bold(`units (${observation.units.length})`),
    ...observation.units.flatMap(unitLines),
    "",
    `toolchains    ${toolchains}`,
    `agent files   ${agentFileSummary(observation)}`,
    `capabilities  ${capabilities === "" ? pc.dim("none observed") : capabilities}`,
  ];
  if (observation.unknowns.length > 0) {
    lines.push("", pc.bold("unknowns"), ...observation.unknowns.map((entry) => `  · ${entry}`));
  }
  if (observation.contradictions.length > 0) {
    lines.push(
      "",
      pc.bold("contradictions"),
      ...observation.contradictions.map((entry) => `  ${pc.yellow("!")} ${entry.explanation}`),
    );
  }
  return lines;
}

export const inspect = defineCommand({
  meta: {
    name: "inspect",
    description: "Read-only discovery: supported, inferred, and unknown facts about a project",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      description: "Project directory (default: the current directory — no walk-up)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("inspect", { json: args.json, events: args.events }, async (ctx) => {
      const observation = await inspectProject(ctx, args.dir ?? ".");
      return {
        ok: true,
        data: observation,
        human: () => {
          for (const line of renderObservation(observation)) console.log(line);
        },
      };
    });
  },
});
