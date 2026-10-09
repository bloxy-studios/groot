/**
 * The groot skill — one canonical text projected byte-identically to
 * `.agents/skills/groot/SKILL.md` (Codex, Cursor, Copilot, Gemini CLI and
 * other agentskills.io hosts) and `.claude/skills/groot/SKILL.md` (Claude
 * Code, which does not read .agents/skills). Spec-only frontmatter (`name`
 * matches the directory; `description` ≤ 1024 chars) keeps both copies
 * portable; the body stays far below the 500-line guidance.
 */

export const SKILL_NAME = "groot";

export const SKILL_PATHS: Readonly<Record<"agents" | "claude", string>> = {
  agents: ".agents/skills/groot/SKILL.md",
  claude: ".claude/skills/groot/SKILL.md",
};

const DESCRIPTION =
  "Use in any project managed by groot (it has a groot.json): read the project map and task-scoped facts, add capabilities such as authentication or typed persistence through previewable plans, apply/resume/roll back operations safely, and prove changes with structural, build, runtime, and product-flow evidence. Teaches the inspect → plan → apply → verify loop and its --json contracts.";

export function renderSkill(): string {
  return `---
name: ${SKILL_NAME}
description: ${DESCRIPTION}
---

# Working in a groot project

groot keeps a project's desired state (\`groot.json\`), exact resolutions and owned files (\`groot.lock.json\`), and local operation state (\`.groot/\`, never committed). Change the project through groot's plans so every change is previewed, journaled, recoverable, and verified.

## The loop

1. **Know the project** — \`groot context --task "<goal>" --json\` returns only what the task needs (apps, commands, env var names, decisions, acceptance checks, known gaps). \`groot inspect --json\` returns full discovery facts with provenance and confidence.
2. **Plan** — \`groot plan add <capability> [--target <app>] --json\` (e.g. \`auth\`, \`data\`). Read the plan: files written/edited (with exact previews), dependency changes, commands, environment contracts, external effects, preconditions, verification, recovery limits. Refusals explain why and list alternatives.
3. **Apply** — \`groot apply <planId> --json\`. If files changed since planning you get \`GROOT_E_STALE_PLAN\` naming them: re-plan, never force.
4. **Verify** — \`groot verify --json\` (structural + build). Add \`--profile runtime,product-flow\` to start the app and drive the real flow. Each check yields evidence (\`pass\`/\`fail\`/\`skipped\`/\`blocked\`) tied to the revision; \`groot evidence <id>\` shows details and logs.
5. **Recover** — \`groot status --json\`; \`groot resume <operationId>\` continues an interrupted operation from its last checkpoint; \`groot rollback <operationId> --dry-run\` previews restoring files Groot changed (refused if you edited them afterwards).

## Rules

- Bun only: \`bun install\`, \`bun run <script>\`, \`bunx <tool>\`. Never npm, npx, yarn, or pnpm.
- Never hand-edit \`groot.json\` or \`groot.lock.json\`; never commit \`.groot/\` or env files with secrets.
- Text between \`groot:begin\`/\`groot:end\` markers is generated; write your notes outside the markers.
- Secrets are generated into gitignored files and never printed; refer to variables by name.
- A task is done when its acceptance checks pass — not when a summary says so.

## Machine contract

Every v2 command accepts \`--json\` (one result envelope on stdout; progress on stderr, \`--events\` for JSONL) and exits with: 0 ok · 2 usage/refused · 3 preflight · 4 command failed · 5 verification failed · 6 conflict/stale · 7 blocked (needs a decision, credential, or prerequisite — see \`blocked[]\`) · 8 locked · 130 interrupted (resumable). Schemas: https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/v2/index.json
`;
}
