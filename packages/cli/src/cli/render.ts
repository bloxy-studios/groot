/**
 * Human renderings of v2 documents (stdout when --json is off). Machine
 * consumers use the JSON envelope; nothing here is a contract.
 */
import pc from "picocolors";
import type { VerificationReport } from "../core/contracts/evidence.ts";
import type { OperationPlan, PlannedAction } from "../core/contracts/plan.ts";

function actionTarget(action: PlannedAction): string {
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.delete":
    case "env.secret":
      return action.path;
    case "file.move":
      return `${action.from} → ${action.to}`;
    case "deps.add":
      return `${action.unit}/package.json`;
    case "command.run":
    case "generator.run":
      return action.argv.join(" ");
    case "internal":
      return action.handler;
    case "external":
      return `${action.provider}: ${action.effect}`;
  }
}

const VERB: Record<PlannedAction["type"], string> = {
  "file.write": "write ",
  "file.edit": "edit  ",
  "file.delete": "delete",
  "file.move": "move  ",
  "deps.add": "deps  ",
  "command.run": "run   ",
  "generator.run": "gen   ",
  internal: "stage ",
  "env.secret": "secret",
  external: "extern",
};

export function renderPlan(plan: OperationPlan): string {
  const lines: string[] = [
    pc.bold(`Plan ${plan.planId}`) + pc.dim(`  (${plan.intent.type})`),
    `  ${plan.summary}`,
  ];
  if (plan.capabilities.selections.length > 0) {
    lines.push("", pc.bold("Capabilities"));
    for (const selection of plan.capabilities.selections) {
      lines.push(
        `  ${selection.capability.padEnd(8)} ${selection.recipe}@${selection.recipeVersion} → ${selection.target}${selection.alreadySatisfied ? pc.dim(" (already present)") : ""}`,
      );
    }
  }
  lines.push("", pc.bold(`Steps (${plan.actions.length})`));
  for (const action of plan.actions) {
    const reversible = action.reversible ? "" : pc.yellow("  irreversible");
    lines.push(
      `  ${pc.dim(action.id)} ${pc.cyan(VERB[action.type])} ${actionTarget(action)}${reversible}`,
    );
    lines.push(`         ${pc.dim(action.description)}`);
  }
  if (plan.dependencies.length > 0) {
    lines.push("", pc.bold("Dependencies"));
    for (const change of plan.dependencies) {
      lines.push(
        `  ${change.unit}: ${change.package} ${change.from ?? "∅"} → ${change.to}${change.dev ? pc.dim(" (dev)") : ""}`,
      );
    }
  }
  if (plan.environment.length > 0) {
    lines.push("", pc.bold("Environment (names only)"));
    for (const contract of plan.environment) {
      lines.push(
        `  ${contract.name.padEnd(24)} ${contract.scope}/${contract.sensitivity}${contract.required ? "" : " (optional)"} → ${contract.storage}`,
      );
    }
  }
  lines.push("", pc.bold("Safety"));
  lines.push(
    `  preconditions: ${plan.preconditions.length} (any changed file makes the plan stale)`,
  );
  lines.push(`  action classes: ${plan.requiredClasses.join(", ") || "none"}`);
  lines.push(`  external effects: ${plan.external.length === 0 ? "none" : plan.external.length}`);
  lines.push(`  recovery: ${plan.recovery.mode} — ${plan.recovery.summary}`);
  for (const limit of plan.recovery.limits) lines.push(`    ${pc.dim(`limit: ${limit}`)}`);
  for (const item of plan.recovery.irreversible)
    lines.push(`    ${pc.yellow(`irreversible: ${item}`)}`);
  if (plan.verification.length > 0) {
    lines.push("", pc.bold("Verification"));
    for (const contract of plan.verification)
      lines.push(`  ${contract.profile.padEnd(13)} ${contract.description}`);
  }
  if (plan.assumptions.length > 0) {
    lines.push("", pc.bold("Assumptions"));
    for (const assumption of plan.assumptions) lines.push(`  • ${assumption}`);
  }
  return lines.join("\n");
}

const STATUS_ICON = {
  pass: pc.green("✓"),
  fail: pc.red("✗"),
  skipped: pc.dim("○"),
  blocked: pc.yellow("●"),
  "not-run": pc.dim("·"),
} as const;

export function renderVerification(report: VerificationReport): string {
  const lines: string[] = [
    pc.bold("Verification") +
      pc.dim(
        `  ${report.revision.head?.slice(0, 12) ?? "no-git"}${report.revision.dirty ? " (dirty)" : ""} · bun ${report.environment.bun}`,
      ),
  ];
  for (const [profile, summary] of Object.entries(report.profiles)) {
    lines.push(
      `  ${STATUS_ICON[summary.status]} ${profile.padEnd(13)} ${summary.status}${summary.status === "not-run" ? "" : pc.dim(`  (${summary.pass} pass · ${summary.fail} fail · ${summary.blocked} blocked · ${summary.skipped} skipped)`)}`,
    );
  }
  lines.push("");
  for (const evidence of report.evidence) {
    lines.push(`  ${STATUS_ICON[evidence.status]} ${evidence.check}  ${pc.dim(evidence.id)}`);
    lines.push(`      ${evidence.summary}`);
    if (evidence.nextStep !== null) lines.push(`      ${pc.cyan("next:")} ${evidence.nextStep}`);
    for (const limitation of evidence.limitations)
      lines.push(`      ${pc.dim(`limitation: ${limitation}`)}`);
  }
  return lines.join("\n");
}
