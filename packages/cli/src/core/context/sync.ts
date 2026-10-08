/**
 * Context synchronization planner: projects the blueprint into managed
 * instruction files without touching human content.
 *
 * - Root AGENTS.md: one managed region (the project map).
 * - CLAUDE.md: a managed `@AGENTS.md` import at the top. A root CLAUDE.md
 *   turns off Claude Code's native AGENTS.md reading, so every nested
 *   AGENTS.md also gets a sibling CLAUDE.md shim.
 * - Skills: the canonical `.agents/skills/groot/SKILL.md` plus a byte-identical
 *   `.claude/skills/groot/SKILL.md`; replaced only while unchanged since
 *   Groot wrote them (per groot.lock.json), otherwise a conflict.
 * - Budgets: region ≤ 8 KiB; warn above 16 KiB root file; refuse to push the
 *   root→nested chain past Codex's 32 KiB combined budget.
 *
 * Everything goes through the PlanBuilder, so a sync is previewable,
 * journaled, and reversible like any other operation.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import type { SyncFileChange } from "../contracts/context.ts";
import type { GrootLock, OwnedArtifact } from "../contracts/lock.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import { planLockUpdate } from "../planner/lock-edit.ts";
import { findRegions, upsertRegion } from "../transforms/regions.ts";
import {
  AGENTS_REGION_ID,
  CHAIN_BUDGET_BYTES,
  CLAUDE_IMPORT_REGION_ID,
  REGION_BUDGET_BYTES,
  ROOT_WARN_BYTES,
  renderAgentsRegion,
  renderClaudeImport,
} from "./agents.ts";
import { renderSkill, SKILL_PATHS } from "./skill.ts";

export interface ContextSyncInput {
  readonly builder: PlanBuilder;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation;
  readonly lock: GrootLock;
  /** Sync the files that can be synced and report the conflicting ones. */
  readonly skipConflicts: boolean;
}

export interface ContextSyncResult {
  readonly changes: SyncFileChange[];
  readonly warnings: string[];
  readonly conflicts: SyncFileChange[];
  /** The groot.lock.json `context` entries after the sync. */
  readonly artifacts: OwnedArtifact[];
}

const bytes = (text: string | null): number => (text === null ? 0 : Buffer.byteLength(text));

/** Is `dir` strictly inside `ancestor`? (project-relative POSIX directories, "." = the root) */
const isInside = (dir: string, ancestor: string): boolean =>
  ancestor === "." ? dir !== "." : dir.startsWith(`${ancestor}/`);

/** A compact, line-prefixed preview of what changes. */
function previewDiff(before: string | null, after: string): string {
  if (before === null)
    return after
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
  const old = new Set(before.split("\n"));
  const next = new Set(after.split("\n"));
  const removed = before
    .split("\n")
    .filter((line) => !next.has(line))
    .map((line) => `- ${line}`);
  const added = after
    .split("\n")
    .filter((line) => !old.has(line))
    .map((line) => `+ ${line}`);
  return [...removed, ...added].join("\n");
}

function isConflict(error: unknown): error is GrootV2Error {
  return (
    error instanceof GrootV2Error &&
    (error.id === "GROOT_E_CONFLICT" || error.id === "GROOT_E_OWNERSHIP_CONFLICT")
  );
}

class SyncSession {
  readonly changes: SyncFileChange[] = [];
  readonly conflicts: SyncFileChange[] = [];
  readonly warnings: string[] = [];
  readonly touched = new Map<string, { ownership: OwnedArtifact["ownership"]; parts: string[] }>();

  constructor(private readonly input: ContextSyncInput) {}

  private get builder(): PlanBuilder {
    return this.input.builder;
  }

  /** Upsert a managed region; absent files are created with `header` above the region. */
  async region(
    path: string,
    regionId: string,
    content: string,
    placement: "start" | "end",
    header: string,
  ): Promise<void> {
    const before = await this.builder.currentContent(path);
    try {
      if (before === null) {
        const created = upsertRegion(
          header,
          { regionId, content, commentStyle: "html", placement },
          path,
        );
        await this.builder.writeFile({
          path,
          content: created,
          description: `create ${path} with the groot-managed "${regionId}" section`,
          ownership: "none",
        });
        this.record(
          path,
          "create",
          [regionId],
          `${path} does not exist yet`,
          previewDiff(null, created),
        );
      } else {
        const id = await this.builder.editFile({
          path,
          edit: { kind: "managed-region", regionId, content, commentStyle: "html", placement },
          description: `refresh the groot-managed "${regionId}" section of ${path} (human text untouched)`,
          owns: [regionId],
          createIfMissing: false,
        });
        const after = (await this.builder.currentContent(path)) ?? before;
        this.record(
          path,
          id === null ? "unchanged" : "update-region",
          [regionId],
          id === null ? "already up to date" : "managed section regenerated",
          id === null ? "" : previewDiff(before, after),
        );
      }
      this.touched.set(path, { ownership: "region", parts: [regionId] });
    } catch (error) {
      if (!isConflict(error)) throw error;
      this.conflict(path, [regionId], error.message);
    }
  }

  /** Whole-file owned projection (skills). */
  async ownedFile(path: string, content: string): Promise<void> {
    const before = await this.builder.currentContent(path);
    const recorded = this.input.lock.context.find(
      (entry) => entry.path === path && entry.ownership === "file",
    );
    if (before !== null && before !== content) {
      const current = sha256Of(before);
      if (recorded === undefined || recorded.sha256 !== current) {
        this.conflict(
          path,
          [],
          recorded === undefined
            ? `${path} exists and was not written by groot — move it or delete it to let groot manage the skill`
            : `${path} was edited by hand since groot wrote it — keep your copy elsewhere or delete it, then sync again`,
        );
        return;
      }
    }
    const id = await this.builder.writeFile({
      path,
      content,
      description: `write the groot skill projection ${path}`,
      ownership: "file",
      replaceSha: before === null ? null : sha256Of(before),
    });
    this.record(
      path,
      before === null ? "create" : id === null ? "unchanged" : "update-region",
      [],
      before === null
        ? "skill not installed yet"
        : id === null
          ? "already up to date"
          : "skill text updated",
      id === null ? "" : previewDiff(before, content),
    );
    this.touched.set(path, { ownership: "file", parts: [] });
  }

  record(
    path: string,
    action: SyncFileChange["action"],
    regions: string[],
    reason: string,
    diff: string,
  ): void {
    this.changes.push({ path, action, regions, reason, diff });
  }

  conflict(path: string, regions: string[], reason: string): void {
    const change: SyncFileChange = { path, action: "conflict", regions, reason, diff: "" };
    this.changes.push(change);
    this.conflicts.push(change);
  }
}

function claudeTarget(observation: ProjectObservation, configured: string): string {
  const claudeFiles = new Set(
    observation.agentFiles.filter((file) => file.tool === "claude-md").map((file) => file.path),
  );
  if (!claudeFiles.has(configured) && claudeFiles.has(".claude/CLAUDE.md"))
    return ".claude/CLAUDE.md";
  return configured;
}

export async function planContextSync(input: ContextSyncInput): Promise<ContextSyncResult> {
  const { blueprint, observation, builder } = input;
  const session = new SyncSession(input);
  const agentsPath = blueprint.context.agentsMd;

  const region = renderAgentsRegion(blueprint, observation);
  if (bytes(region) > REGION_BUDGET_BYTES) {
    session.warnings.push(
      `the generated project map is ${bytes(region)} bytes (budget ${REGION_BUDGET_BYTES}); consider fewer apps per project`,
    );
  }
  const header = `# ${blueprint.project.name}\n\nGuidance for humans and coding agents. Add your own notes anywhere outside the groot block below.\n\n`;
  await session.region(agentsPath, AGENTS_REGION_ID, region, "end", header);

  const rootAfter = await builder.currentContent(agentsPath);
  if (bytes(rootAfter) > ROOT_WARN_BYTES) {
    session.warnings.push(
      `${agentsPath} is ${bytes(rootAfter)} bytes — agents read it on every task; keep it under ${ROOT_WARN_BYTES}`,
    );
  }

  const nested = observation.agentFiles.filter(
    (file) => file.tool === "agents-md" && file.path !== agentsPath,
  );
  if (blueprint.context.claudeMd !== null) {
    const target = claudeTarget(observation, blueprint.context.claudeMd);
    const importLine = target.startsWith(".claude/") ? "@../AGENTS.md" : renderClaudeImport();
    await session.region(target, CLAUDE_IMPORT_REGION_ID, importLine, "start", "");
    for (const file of nested) {
      await session.region(
        `${dirname(file.path)}/CLAUDE.md`,
        CLAUDE_IMPORT_REGION_ID,
        renderClaudeImport(),
        "start",
        "",
      );
    }
  }

  // Codex concatenates every AGENTS.md from the root down to the working
  // directory, so each nested file's chain is the root plus all of its
  // ancestors' AGENTS.md — whether or not the project uses CLAUDE.md.
  const rootBefore = bytes(await readOriginal(builder, agentsPath));
  for (const file of nested) {
    const dir = dirname(file.path);
    const above = nested.filter((other) => isInside(dir, dirname(other.path)));
    const files = [agentsPath, ...above.map((other) => other.path).sort(), file.path];
    const nestedBytes = [...above, file].reduce((sum, entry) => sum + entry.bytes, 0);
    const chain = bytes(rootAfter) + nestedBytes;
    if (chain > CHAIN_BUDGET_BYTES && rootBefore + nestedBytes <= CHAIN_BUDGET_BYTES) {
      throw new GrootV2Error(
        "GROOT_E_BLOCKED",
        `Syncing would push ${files.join(" + ")} to ${chain} bytes, past Codex's ${CHAIN_BUDGET_BYTES}-byte AGENTS.md budget (it truncates the most specific file first).`,
        {
          hint: "Shorten the nested AGENTS.md or move detail into skills/docs, then sync again.",
          details: { chain, files },
        },
      );
    }
    if (chain > CHAIN_BUDGET_BYTES) {
      session.warnings.push(
        `${files.join(" + ")} already exceed Codex's ${CHAIN_BUDGET_BYTES}-byte budget`,
      );
    }
  }

  for (const host of blueprint.context.skills) {
    await session.ownedFile(SKILL_PATHS[host], renderSkill());
  }

  if (session.conflicts.length > 0 && !input.skipConflicts) {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `Context sync would overwrite human edits in: ${session.conflicts.map((change) => change.path).join(", ")}.`,
      {
        hint: "Resolve those files (or pass --skip-conflicts to sync everything else), then run groot context sync again.",
        details: { conflicts: session.conflicts },
      },
    );
  }

  const artifacts: OwnedArtifact[] = [];
  for (const [path, owned] of [...session.touched].sort(([a], [b]) => a.localeCompare(b))) {
    const content = await builder.currentContent(path);
    if (content === null) continue;
    if (owned.ownership === "region" && findRegions(content, path).length === 0) continue;
    artifacts.push({
      path,
      ownership: owned.ownership,
      parts: owned.parts,
      sha256: sha256Of(content),
    });
  }
  // Record ownership in the lock unless nothing would change.
  const unchanged =
    JSON.stringify(artifacts) ===
    JSON.stringify([...input.lock.context].sort((a, b) => a.path.localeCompare(b.path)));
  if (!unchanged) {
    await planLockUpdate(
      builder,
      input.lock,
      [{ op: "set", pointer: "/context", value: artifacts }],
      "record the managed instruction files and their hashes in groot.lock.json",
      ["/context"],
    );
  }
  return {
    changes: session.changes,
    warnings: session.warnings,
    conflicts: session.conflicts,
    artifacts,
  };
}

/** The file as it is on disk now (before this plan), not as the plan will leave it. */
async function readOriginal(builder: PlanBuilder, path: string): Promise<string | null> {
  try {
    return await readFile(resolveInProject(builder.root, path), "utf8");
  } catch {
    return null;
  }
}
