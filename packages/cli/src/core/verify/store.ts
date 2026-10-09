/**
 * Evidence store: `.groot/evidence/<id>/evidence.json` plus redacted
 * artifacts (logs, HTTP transcripts). Evidence is addressable by id so
 * agents and reviews reference it instead of carrying whole logs in context.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceId } from "../contracts/common.ts";
import { type Evidence, Evidence as EvidenceSchema } from "../contracts/evidence.ts";
import { GrootV2Error } from "../errors.ts";
import { writeFileAtomic } from "../fs/atomic.ts";
import { sha256Of } from "../fs/hash.ts";
import { toProjectPath } from "../fs/paths.ts";
import { prettyJson } from "../json.ts";
import { redact, redactValue } from "../redact.ts";
import { ensureStateDir, statePaths } from "../state.ts";

export interface ArtifactInput {
  /** File name inside the evidence directory ("server.log"). */
  readonly name: string;
  readonly kind: "log" | "json" | "text";
  readonly content: string;
}

const RECORD_FILE = "evidence.json";

/** One path segment: not empty, `.`, or `..`, and no separators or control characters. */
const FILE_NAME = /^(?!\.\.?$)[^/\\\p{Cc}]+$/u;

/** Refuse an artifact name that is not a plain file name beside the record. */
function checkArtifactName(name: string): void {
  if (FILE_NAME.test(name) && name !== RECORD_FILE) return;
  const reason =
    name === RECORD_FILE
      ? "that name is reserved for the evidence record"
      : "it must be a single file name inside the evidence directory";
  throw new GrootV2Error(
    "GROOT_E_PATH_OUTSIDE_PROJECT",
    `Refusing evidence artifact "${name}": ${reason}.`,
    { details: { name, reason } },
  );
}

/**
 * Persist evidence and its artifacts. Everything is redacted with the run's
 * known secrets first — artifact content and every field of the record
 * (summary, details, reason, nextStep, limitations, …), since summaries are
 * built from command output. Artifact names are checked before anything is
 * written. Returns the stored, validated record.
 */
export function storeEvidence(
  root: string,
  evidence: Omit<Evidence, "artifacts">,
  artifacts: readonly ArtifactInput[],
  secrets: readonly string[] = [],
): Evidence {
  for (const artifact of artifacts) checkArtifactName(artifact.name);
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
  const record = EvidenceSchema.parse(redactValue({ ...evidence, artifacts: stored }, secrets));
  writeFileAtomic(join(dir, RECORD_FILE), prettyJson(record));
  return record;
}

export async function readEvidence(root: string, id: string): Promise<Evidence> {
  const notFound = (): GrootV2Error =>
    new GrootV2Error("GROOT_E_NOT_FOUND", `No evidence ${id} in this project.`, {
      hint: "List evidence with `groot evidence`.",
    });
  // Validated before it becomes a path segment: an id is never a traversal.
  if (!EvidenceId.safeParse(id).success) throw notFound();
  let raw: string;
  try {
    raw = await readFile(join(statePaths.evidence(root, id), RECORD_FILE), "utf8");
  } catch (error) {
    if (error instanceof GrootV2Error) throw error; // e.g. a symlinked state directory
    throw notFound();
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
