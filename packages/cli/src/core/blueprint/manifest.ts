/**
 * groot.json reading for v2 surfaces: one entry point that tells an absent
 * file, a v1 manifest, and a v2 blueprint apart and validates each against
 * its contract.
 *
 * - v1 is checked with the zod ManifestV1 contract (the frozen v1 schema)
 *   PLUS the semantic rule engine/manifest.ts validateManifest enforces that
 *   a JSON schema cannot: every scaffold's framework must be offered in its
 *   slot by this CLI's matrix (so `{slot:"web", framework:"hono"}` is
 *   refused here exactly as `groot add`/`doctor` refuse it).
 * - v2 is checked with the BlueprintV2 contract, the same slot/framework
 *   rule for its v1-shaped `scaffolds`, and unique app ids (capabilities
 *   target apps by id — duplicates would make targeting ambiguous).
 * - Any other number is GROOT_E_UNSUPPORTED_SCHEMA; anything unparseable or
 *   off-contract is GROOT_E_INVALID_DOCUMENT with pointer issue paths.
 */
import { findChoice } from "../../engine/matrix.ts";
import {
  BLUEPRINT_VERSION,
  BlueprintV2,
  GROOT_JSON_SCHEMA_URL,
  type LegacyScaffold,
  MANIFEST_V1_VERSION,
  ManifestV1,
} from "../contracts/blueprint.ts";
import type { Sha256 } from "../contracts/common.ts";
import { GrootV2Error } from "../errors.ts";
import { type DocumentIssue, invalidDocument, readRootDocument, zodIssues } from "./document.ts";

export const MANIFEST_FILE = "groot.json";

export type ManifestRead =
  | { readonly state: "absent" }
  | {
      readonly state: "v1";
      readonly doc: ManifestV1;
      readonly sha256: Sha256;
      readonly raw: string;
    }
  | {
      readonly state: "v2";
      readonly doc: BlueprintV2;
      readonly sha256: Sha256;
      readonly raw: string;
    };

const SUPPORTED_VERSIONS = [MANIFEST_V1_VERSION, BLUEPRINT_VERSION] as const;

const MANIFEST_HINT = `groot.json is written by groot — restore it from version control or fix the listed fields (schema: ${GROOT_JSON_SCHEMA_URL}).`;

/** Scaffolds whose framework this CLI's matrix doesn't offer in that slot (validateManifest parity). */
function scaffoldIssues(scaffolds: readonly LegacyScaffold[]): DocumentIssue[] {
  return scaffolds.flatMap((scaffold, index) =>
    findChoice(scaffold.slot, scaffold.framework) === undefined
      ? [
          {
            path: `/scaffolds/${index}/framework`,
            message: `"${scaffold.framework}" is not a known ${scaffold.slot} framework for this CLI version`,
          },
        ]
      : [],
  );
}

function duplicateAppIssues(doc: BlueprintV2): DocumentIssue[] {
  const seen = new Set<string>();
  return doc.apps.flatMap((app, index) => {
    if (!seen.has(app.id)) {
      seen.add(app.id);
      return [];
    }
    return [{ path: `/apps/${index}/id`, message: `duplicate app id "${app.id}"` }];
  });
}

function unsupportedVersion(version: number): GrootV2Error {
  return new GrootV2Error(
    "GROOT_E_UNSUPPORTED_SCHEMA",
    `groot.json declares version ${version}; this CLI reads versions 1 and 2.`,
    {
      hint:
        version > BLUEPRINT_VERSION
          ? "It was written by a newer groot — upgrade (bunx create-groot@latest) before working with it."
          : "Restore a groot.json written by groot (version 1 or 2).",
      details: { path: MANIFEST_FILE, version, supported: [...SUPPORTED_VERSIONS] },
    },
  );
}

/** Read and validate `<root>/groot.json` (no walk-up: the root is explicit). */
export async function readManifest(root: string): Promise<ManifestRead> {
  const document = await readRootDocument(root, MANIFEST_FILE, MANIFEST_HINT);
  if (document === null) return { state: "absent" };
  const { raw, sha256, value } = document;
  const version = (value as Record<string, unknown>).version;

  if (version === MANIFEST_V1_VERSION) {
    const parsed = ManifestV1.safeParse(value);
    if (!parsed.success) {
      throw invalidDocument(MANIFEST_FILE, zodIssues(parsed.error), {
        hint: MANIFEST_HINT,
        version,
      });
    }
    const issues = scaffoldIssues(parsed.data.scaffolds);
    if (issues.length > 0) {
      throw invalidDocument(MANIFEST_FILE, issues, { hint: MANIFEST_HINT, version });
    }
    return { state: "v1", doc: parsed.data, sha256, raw };
  }

  if (version === BLUEPRINT_VERSION) {
    const parsed = BlueprintV2.safeParse(value);
    if (!parsed.success) {
      throw invalidDocument(MANIFEST_FILE, zodIssues(parsed.error), {
        hint: MANIFEST_HINT,
        version,
      });
    }
    const issues = [...scaffoldIssues(parsed.data.scaffolds), ...duplicateAppIssues(parsed.data)];
    if (issues.length > 0) {
      throw invalidDocument(MANIFEST_FILE, issues, { hint: MANIFEST_HINT, version });
    }
    return { state: "v2", doc: parsed.data, sha256, raw };
  }

  if (typeof version === "number") throw unsupportedVersion(version);
  throw invalidDocument(
    MANIFEST_FILE,
    [{ path: "/version", message: "expected the number 1 or 2" }],
    { hint: MANIFEST_HINT },
  );
}
