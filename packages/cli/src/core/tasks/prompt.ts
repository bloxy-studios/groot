/**
 * Prompts sent to runners. The objective, ownership boundary, acceptance
 * commands, and rules go in the user prompt (stdin) so every runner sees
 * them; the rules are ALSO appended to Claude's system prompt. Nothing here
 * contains secret values — the project context comes from the coordinator's
 * provider (names and commands only).
 */
import type { Task } from "../contracts/task.ts";
import { formatArgv } from "./argv.ts";
import type { AcceptanceRecord } from "./store.ts";

/** Read-only git commands the agent may run besides the acceptance commands. */
const READ_ONLY_COMMANDS = ["git status", "git diff"];

function ownershipLine(task: Task): string {
  return task.ownership.includes("**")
    ? "You may change any file in this worktree."
    : `Only change files matching: ${task.ownership.map((glob) => `\`${glob}\``).join(", ")}. Leave every other file untouched.`;
}

function commandCriteria(task: Task): string[] {
  return task.acceptance
    .filter((criterion) => criterion.kind === "command" && criterion.argv !== null)
    .map((criterion) => formatArgv(criterion.argv ?? []));
}

/** Command prefixes the agent may run (Claude allow rules). */
export function allowedCommands(task: Task): string[] {
  return [
    ...new Set([
      ...task.acceptance
        .filter((criterion) => criterion.kind === "command" && criterion.argv !== null)
        .map((criterion) => (criterion.argv ?? []).join(" ")),
      ...READ_ONLY_COMMANDS,
    ]),
  ];
}

function acceptanceLines(task: Task): string[] {
  if (task.acceptance.length === 0) return ["- (none — a human reviews the change)"];
  return task.acceptance.map((criterion) =>
    criterion.kind === "command"
      ? `- \`${formatArgv(criterion.argv ?? [])}\`${criterion.cwd === "." ? "" : ` (in ${criterion.cwd})`}`
      : `- Groot verification profile "${criterion.profile}" (Groot runs this one)`,
  );
}

function runLine(task: Task): string {
  const commands = commandCriteria(task);
  return commands.length === 0
    ? "Check your work before finishing."
    : `Before you finish, run ${commands.map((command) => `\`${command}\``).join(", ")} and make sure ${commands.length === 1 ? "it passes" : "they pass"}.`;
}

/** Task rules (Claude: --append-system-prompt; everyone: end of the prompt). */
export function taskRules(task: Task): string {
  return [
    "You are a coding agent running a bounded task for Groot in a dedicated git worktree.",
    "Rules:",
    `1. Stay inside this worktree. ${ownershipLine(task)}`,
    "2. Do not commit, push, merge, create branches, or rewrite git history — Groot commits your changes and a human reviews them before integration.",
    `3. ${runLine(task)} Do not weaken, skip, or delete the checks to make them pass.`,
    "4. Never print, write, or commit secrets (API keys, tokens, passwords, private keys).",
    "5. Finish with a short summary of what you changed and the check results.",
  ].join("\n");
}

/** The first prompt of a task. */
export function startPrompt(task: Task, context: string | null): string {
  const sections = [
    `# Task ${task.id}: ${task.title}`,
    `## Objective\n\n${task.objective}`,
    `## Ownership\n\n${ownershipLine(task)}`,
    `## Acceptance\n\nGroot runs these checks after you finish; the task is accepted only if all pass:\n\n${acceptanceLines(task).join("\n")}`,
    `## Rules\n\n${taskRules(task)}`,
  ];
  if (context !== null && context.trim() !== "") {
    sections.push(`## Project context (from groot)\n\n${context.trim()}`);
  }
  return `${sections.join("\n\n")}\n`;
}

export type ContinueReason =
  | { readonly kind: "resume"; readonly acceptance: readonly AcceptanceRecord[] | null }
  | { readonly kind: "retry"; readonly failures: readonly AcceptanceRecord[] }
  | { readonly kind: "runner-failed"; readonly error: string }
  | { readonly kind: "changes-requested"; readonly notes: string };

function acceptanceStatus(records: readonly AcceptanceRecord[] | null): string {
  if (records === null || records.length === 0) return "Acceptance status: not run yet.";
  return `Acceptance status (last run): ${records.map((record) => `${record.criterion} ${record.status}`).join(", ")}.`;
}

function failureBlocks(failures: readonly AcceptanceRecord[]): string {
  return failures
    .map((record) => {
      const output = record.tail.trim() === "" ? "" : `\n\n\`\`\`\n${record.tail.trim()}\n\`\`\``;
      return `### ${record.criterion} — ${record.status}\n\n${record.summary}${output}`;
    })
    .join("\n\n");
}

/** A prompt that continues the same runner session (resume, retry, review feedback). */
export function continuePrompt(task: Task, reason: ContinueReason): string {
  const head = `Continue task ${task.id} (${task.title}).`;
  let body: string;
  switch (reason.kind) {
    case "resume":
      body = `The previous run was interrupted before it finished. Continue where you left off.\n\n${acceptanceStatus(reason.acceptance)}`;
      break;
    case "retry":
      body = `Groot ran the acceptance checks on your changes and they did not all pass:\n\n${failureBlocks(reason.failures)}\n\nFix the cause in the code (do not weaken or delete the checks), run the checks again, and finish.`;
      break;
    case "runner-failed":
      body = `Your previous run ended early: ${reason.error}\nContinue the task and finish it.`;
      break;
    case "changes-requested":
      body = `A reviewer looked at your change and requested changes:\n\n${reason.notes.trim()}\n\nAddress every point.`;
      break;
  }
  return `${head}\n\n${body}\n\n${taskRules(task)}\n`;
}
