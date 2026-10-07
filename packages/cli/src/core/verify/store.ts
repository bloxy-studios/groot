/**
 * Evidence store: `.groot/evidence/<id>/evidence.json` plus redacted
 * artifacts (logs, HTTP transcripts). Evidence is addressable by id so
 * agents and reviews reference it instead of carrying whole logs in context.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Evidence, Evidence as EvidenceSchema } from "../contracts/evidence.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { sha256Of } from "../fs/hash.ts";
import { toProjectPath } from "../fs/paths.ts";
import { prettyJson } from "../json.ts";
import { redact } from "../redact.ts";
import { ensureStateDir, statePaths } from "../state.ts";

export interface ArtifactInput {
  /** File name inside the evidence directory ("server.log"). */
  readonly name: string;
  readonly kind: "log" | "json" | "text";
  readonly content: string;
}

/**
 * Persist evidence and its artifacts (artifact content is redacted with the
 * run's known secrets first). Returns the stored, validated record.
 */
export function storeEvidence(
  root: string,
  evidence: Omit<Evidence, "artifacts">,
  artifacts: readonly ArtifactInput[],
  secrets: readonly string[] = [],
): Evidence {
  ensureStateDir(root);
  const dir = statePaths.evidence(root, evidence.id);
  const stored = artifacts.map((artifact) => {
    const content = redact(artifact.content, secrets);
    const absolute = join(dir, artifact.name);
    writeFileAtomic(absolute, content);
    return {
      path: toProjectPath(root, absolute),
      kind: artifact.kind,
      sha256: sha256Of(content),
      bytes: Buffer.byteLength(content),
    };
  });
  const record = EvidenceSchema.parse({ ...evidence, artifacts: stored });
  writeFileAtomic(join(dir, "evidence.json"), prettyJson(record));
  return record;
}

export async function readEvidence(root: string, id: string): Promise<Evidence> {
  let raw: string;
  try {
    raw = await readFile(join(statePaths.evidence(root, id), "evidence.json"), "utf8");
  } catch {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `No evidence ${id} in this project.`, {
      hint: "List evidence with `groot evidence`.",
    });
  }
  return EvidenceSchema.parse(JSON.parse(raw));
}

/** All stored evidence, newest first (ids are time-sortable). */
export async function listEvidence(root: string): Promise<Evidence[]> {
  let ids: string[];
  try {
    ids = await readdir(statePaths.evidenceRoot(root));
  } catch {
    return [];
  }
  const records: Evidence[] = [];
  for (const id of ids
    .filter((entry) => entry.startsWith("ev_"))
    .sort()
    .reverse()) {
    try {
      records.push(await readEvidence(root, id));
    } catch {
      // a torn or foreign directory is skipped, not fatal
    }
  }
  return records;
}
