/**
 * Agent instruction files and their managed regions.
 *
 * Found: AGENTS.md, CLAUDE.md, and CLAUDE.local.md at the root and in nested
 * directories (core/context/sync.ts gives every nested AGENTS.md a sibling
 * CLAUDE.md shim); .claude/CLAUDE.md; skills under .claude/skills,
 * .agents/skills, and .codex/skills; .cursor/rules/**; the Copilot
 * instructions file; and .mcp.json. Each is reported with its size, hash, and
 * the state of every groot-managed region (intact, or edited by hand since
 * Groot wrote it). A region with a missing end marker is reported as a
 * contradiction — a hand-edited file must never crash discovery.
 */
import type { Sha256 } from "../contracts/common.ts";
import type { AgentFile } from "../contracts/project.ts";
import { findRegions, TransformConflict } from "../transforms/index.ts";
import type { ContradictionNote } from "./facts.ts";
import type { DirEntry, ProjectFs } from "./fs.ts";

type AgentTool = AgentFile["tool"];

export interface AgentFileFindings {
  readonly files: AgentFile[];
  readonly contradictions: ContradictionNote[];
}

/** Instruction files recognized in any (non-hidden, non-skipped) directory. */
const NESTED_FILES: Readonly<Record<string, AgentTool>> = {
  "AGENTS.md": "agents-md",
  "CLAUDE.md": "claude-md",
  "CLAUDE.local.md": "claude-local-md",
};

const ROOT_FILES: ReadonlyArray<readonly [string, AgentTool]> = [
  [".claude/CLAUDE.md", "claude-md"],
  [".github/copilot-instructions.md", "copilot-instructions"],
  [".mcp.json", "mcp-config"],
];

const SKILL_ROOTS: ReadonlyArray<readonly [string, AgentTool]> = [
  [".claude/skills", "claude-skill"],
  [".agents/skills", "agent-skill"],
  [".codex/skills", "codex-skill"],
];

const CURSOR_RULES = ".cursor/rules";
const NESTED_SEARCH = { maxDepth: 8, maxDirs: 5000 } as const;
const CURSOR_DEPTH = 4;

async function nestedCandidates(fs: ProjectFs): Promise<Map<string, AgentTool>> {
  const found = new Map<string, AgentTool>();
  await fs.walk({
    ...NESTED_SEARCH,
    skipHidden: true,
    visit: (_dir: string, entries: readonly DirEntry[]) => {
      for (const entry of entries) {
        const tool = NESTED_FILES[entry.name];
        if (entry.type === "file" && tool !== undefined) found.set(entry.path, tool);
      }
    },
  });
  return found;
}

async function skillCandidates(fs: ProjectFs): Promise<Map<string, AgentTool>> {
  const found = new Map<string, AgentTool>();
  for (const [root, tool] of SKILL_ROOTS) {
    for (const entry of await fs.list(root)) {
      if (entry.type !== "dir") continue;
      const skill = `${entry.path}/SKILL.md`;
      if (await fs.isFile(skill)) found.set(skill, tool);
    }
  }
  return found;
}

async function cursorCandidates(fs: ProjectFs): Promise<Map<string, AgentTool>> {
  const found = new Map<string, AgentTool>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await fs.list(dir)) {
      if (entry.type === "file") found.set(entry.path, "cursor-rules");
      else if (!entry.symlink && depth < CURSOR_DEPTH) await visit(entry.path, depth + 1);
    }
  };
  await visit(CURSOR_RULES, 0);
  return found;
}

/** Find every agent file with its managed-region states. */
export async function findAgentFiles(fs: ProjectFs): Promise<AgentFileFindings> {
  const candidates = new Map<string, AgentTool>([
    ...(await nestedCandidates(fs)),
    ...(await skillCandidates(fs)),
    ...(await cursorCandidates(fs)),
  ]);
  for (const [path, tool] of ROOT_FILES) {
    if (await fs.isFile(path)) candidates.set(path, tool);
  }
  const files: AgentFile[] = [];
  const contradictions: ContradictionNote[] = [];
  for (const [path, tool] of [...candidates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const content = await fs.readText(path);
    if (content === null) continue;
    let managedRegions: AgentFile["managedRegions"] = [];
    try {
      managedRegions = findRegions(content.text, path).map((region) => ({
        id: region.id,
        recordedHash: region.recordedHash as Sha256 | null,
        actualHash: region.actualHash as Sha256,
        intact: region.intact,
      }));
    } catch (error) {
      if (!(error instanceof TransformConflict)) throw error;
      contradictions.push({
        topic: "managed-region",
        explanation: `${path}: ${error.reason} — groot will not edit this file until the markers are repaired`,
        sources: [path],
      });
    }
    files.push({ path, tool, bytes: content.bytes, sha256: content.sha256, managedRegions });
  }
  return { files, contradictions };
}
