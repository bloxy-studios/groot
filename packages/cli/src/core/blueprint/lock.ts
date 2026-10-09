/**
 * groot.lock.json helpers: read/validate, the empty lock adoption writes,
 * and the generator entries a v1 → v2 migration records.
 *
 * Migration is offline by design, so every generator it records is
 * `source: "unresolved"` with null version/integrity/tarball — the exact
 * resolution (core/registry) happens in a later, explicit operation instead
 * of being guessed or silently fetched while rewriting groot.json.
 */
import type { LegacyScaffold } from "../contracts/blueprint.ts";
import { type Sha256, schemaUrl, UnitPath } from "../contracts/common.ts";
import { type GeneratorLock, GrootLock, LOCK_FILE, LOCK_VERSION } from "../contracts/lock.ts";
import { GrootV2Error } from "../errors.ts";
import { joinRel } from "../fs/paths.ts";
import { createdWith } from "../runtime.ts";
import { invalidDocument, readRootDocument, zodIssues } from "./document.ts";

export type LockRead =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly doc: GrootLock;
      readonly sha256: Sha256;
      readonly raw: string;
    };

const LOCK_HINT = `${LOCK_FILE} is written by groot — restore it from version control or fix the listed fields (schema: ${schemaUrl("lock")}).`;

/** Read and validate `<root>/groot.lock.json`. */
export async function readLock(root: string): Promise<LockRead> {
  const document = await readRootDocument(root, LOCK_FILE, LOCK_HINT);
  if (document === null) return { state: "absent" };
  const { raw, sha256, value } = document;
  const lockVersion = (value as Record<string, unknown>).lockVersion;
  if (typeof lockVersion === "number" && lockVersion !== LOCK_VERSION) {
    throw new GrootV2Error(
      "GROOT_E_UNSUPPORTED_SCHEMA",
      `${LOCK_FILE} declares lockVersion ${lockVersion}; this CLI reads lock version ${LOCK_VERSION}.`,
      {
        hint: "It was written by a different groot release — use a matching groot version.",
        details: { path: LOCK_FILE, version: lockVersion, supported: [LOCK_VERSION] },
      },
    );
  }
  const parsed = GrootLock.safeParse(value);
  if (!parsed.success) {
    throw invalidDocument(LOCK_FILE, zodIssues(parsed.error), { hint: LOCK_HINT });
  }
  return { state: "present", doc: parsed.data, sha256, raw };
}

/** A lock with nothing resolved yet (adoption runs no generator or recipe). */
export function emptyLock(): GrootLock {
  return {
    $schema: schemaUrl("lock"),
    lockVersion: LOCK_VERSION,
    generatedBy: createdWith(),
    generators: [],
    recipes: [],
    context: [],
  };
}

/**
 * Split a pinned generator invocation into package and series:
 * "create-next-app@16" → create-next-app / "16";
 * "@tanstack/cli@0.69" → @tanstack/cli / "0.69". The version separator is
 * the last "@" that isn't the scope marker; an unpinned spec means any ("*").
 */
export function parseGeneratorSpec(spec: string): { package: string; range: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { package: spec, range: "*" };
  const range = spec.slice(at + 1);
  return { package: spec.slice(0, at), range: range === "" ? "*" : range };
}

/**
 * Unresolved generator entries for v1 scaffolds — one per distinct
 * package + series, in scaffold order, listing every scaffold path that used it.
 */
export function unresolvedGeneratorLocks(
  scaffolds: readonly LegacyScaffold[],
  resolvedAt: string,
): GeneratorLock[] {
  const byKey = new Map<string, GeneratorLock>();
  for (const scaffold of scaffolds) {
    if (scaffold.generator === null) continue;
    const { package: name, range } = parseGeneratorSpec(scaffold.generator);
    const key = `${name}@${range}`;
    const parsedPath = UnitPath.safeParse(joinRel(scaffold.path));
    const usedBy = parsedPath.success ? [parsedPath.data] : [];
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        package: name,
        range,
        version: null,
        integrity: null,
        tarball: null,
        resolvedAt,
        source: "unresolved",
        usedBy,
      });
    } else {
      byKey.set(key, { ...existing, usedBy: [...new Set([...existing.usedBy, ...usedBy])] });
    }
  }
  return [...byKey.values()];
}

/** The lock a v1 → v2 migration writes: empty plus unresolved generator entries. */
export function migrationLock(scaffolds: readonly LegacyScaffold[], now: Date): GrootLock {
  return { ...emptyLock(), generators: unresolvedGeneratorLocks(scaffolds, now.toISOString()) };
}
