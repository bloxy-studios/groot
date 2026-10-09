/**
 * Context contract — concise, task-scoped project knowledge for humans and
 * agents (`groot context --task …`). Built from current discovery facts and
 * the blueprint, with provenance for every source. It carries variable NAMES,
 * never values, and no private agent session state.
 */
import { z } from "zod";
import { Decision, EvidenceId, RevisionInfo, Topology, UnitPath } from "./common.ts";

export const ContextUnit = z
  .object({
    id: z.string(),
    path: UnitPath,
    kind: z.string(),
    framework: z.string().nullable(),
    entry: z.string().nullable(),
    scripts: z.array(z.string()),
    relevance: z.number().min(0).max(1),
    why: z.string(),
  })
  .strict();

export const TaskContext = z
  .object({
    $schema: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal("groot.context"),
    task: z.string().nullable(),
    project: z
      .object({
        name: z.string(),
        topology: z.union([Topology, z.literal("unknown")]),
        registered: z.boolean(),
        revision: RevisionInfo,
      })
      .strict(),
    units: z.array(ContextUnit),
    capabilities: z.array(
      z.object({ id: z.string(), recipe: z.string(), target: z.string() }).strict(),
    ),
    decisions: z.array(Decision),
    conventions: z.array(z.string()),
    commands: z.array(
      z.object({ purpose: z.string(), command: z.string(), cwd: UnitPath }).strict(),
    ),
    environment: z.array(
      z
        .object({
          name: z.string(),
          consumer: UnitPath,
          scope: z.string(),
          sensitivity: z.string(),
          required: z.boolean(),
          storage: z.string(),
        })
        .strict(),
    ),
    acceptance: z.array(
      z
        .object({
          id: z.string(),
          profile: z.string(),
          description: z.string(),
          command: z.string(),
        })
        .strict(),
    ),
    evidence: z.array(
      z.object({ id: EvidenceId, check: z.string(), status: z.string(), at: z.string() }).strict(),
    ),
    gaps: z.array(z.string()),
    sources: z.array(z.string()),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContext>;

export const SyncFileChange = z
  .object({
    path: z.string(),
    action: z.enum(["create", "update-region", "unchanged", "conflict"]),
    regions: z.array(z.string()),
    reason: z.string(),
    diff: z.string(),
  })
  .strict();
export type SyncFileChange = z.infer<typeof SyncFileChange>;
