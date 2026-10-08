/**
 * Shared reading of Groot's committed JSON documents (groot.json,
 * groot.lock.json): bytes are read through the project boundary (a symlink
 * that leaves the project is refused), fingerprinted over the exact bytes —
 * the same hash the PlanBuilder records as a precondition — and parsed with
 * failures reported as GROOT_E_INVALID_DOCUMENT carrying JSON-pointer issue
 * paths, so agents can point at the broken field instead of parsing prose.
 */
import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";
import type { Sha256 } from "../contracts/common.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";

export interface DocumentIssue {
  /** RFC 6901 pointer into the document ("" = the whole document). */
  readonly path: string;
  readonly message: string;
}

export interface RawDocument {
  readonly raw: string;
  readonly sha256: Sha256;
  readonly value: unknown;
}

const MAX_ISSUES_IN_MESSAGE = 5;

function escapePointerSegment(segment: PropertyKey): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** zod issues → pointer-addressed issues. */
export function zodIssues(error: z.ZodError): DocumentIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "" : `/${issue.path.map(escapePointerSegment).join("/")}`,
    message: issue.message,
  }));
}

export function invalidDocument(
  file: string,
  issues: readonly DocumentIssue[],
  options: { readonly hint: string; readonly version?: number | null },
): GrootV2Error {
  const listed = issues
    .slice(0, MAX_ISSUES_IN_MESSAGE)
    .map((issue) => `${issue.path === "" ? "(document)" : issue.path}: ${issue.message}`)
    .join("; ");
  const more =
    issues.length > MAX_ISSUES_IN_MESSAGE
      ? ` (+${issues.length - MAX_ISSUES_IN_MESSAGE} more)`
      : "";
  return new GrootV2Error("GROOT_E_INVALID_DOCUMENT", `${file} is invalid — ${listed}${more}.`, {
    hint: options.hint,
    details: { path: file, version: options.version ?? null, issues },
  });
}

/**
 * Read and parse a project-root JSON document. Returns null when the file is
 * absent; throws GROOT_E_INVALID_DOCUMENT for non-files and unparseable JSON
 * and GROOT_E_PATH_OUTSIDE_PROJECT for a symlink leaving the project.
 */
export async function readRootDocument(
  root: string,
  file: string,
  hint: string,
): Promise<RawDocument | null> {
  let absolute: string;
  try {
    absolute = resolveInProject(root, file);
  } catch (error) {
    // A missing root has no documents; boundary violations stay errors.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let bytes: Buffer;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw invalidDocument(file, [{ path: "", message: "expected a regular file" }], { hint });
    }
    bytes = await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidDocument(file, [{ path: "", message: `not valid JSON (${message})` }], { hint });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDocument(file, [{ path: "", message: "expected a JSON object" }], { hint });
  }
  return { raw, sha256: sha256Of(bytes), value };
}
