/**
 * The structured-edit dispatcher shared by planners (exact previews) and the
 * executor (deferred edits on files produced earlier in the same operation).
 * Every transform is a pure function of (current text, edit) → new text, or a
 * TransformConflict when a safe match can't be established. Transforms keep
 * the file's line endings and return `current` itself when nothing changes,
 * so a no-op is detectable by equality.
 */
import type { StructuredEdit } from "../contracts/plan.ts";
import { TransformConflict } from "./errors.ts";
import { applyJsonEdit } from "./json.ts";
import { insertAtAnchor, preservingLineEndings, upsertRegion } from "./regions.ts";

/** Append lines missing from the file (exact-line membership after trimming). */
export function appendMissingLines(
  current: string | null,
  lines: readonly string[],
  header: string | null,
): string {
  return preservingLineEndings(current, (text) => {
    const present = new Set(text.split("\n").map((line) => line.trim()));
    const missing = [...new Set(lines)].filter((line) => !present.has(line.trim()));
    if (missing.length === 0) return text;
    const prefix = text === "" ? "" : text.endsWith("\n") ? "" : "\n";
    const spacer = text === "" ? "" : "\n";
    const head = header === null ? [] : [header];
    return `${text}${prefix}${spacer}${[...head, ...missing].join("\n")}\n`;
  });
}

/** Add `NAME=value` entries whose NAME isn't assigned yet (comments/exports tolerated). */
export function addEnvEntries(
  current: string | null,
  entries: readonly { name: string; value: string; comment: string | null }[],
): string {
  return preservingLineEndings(current, (text) => {
    const assigned = new Set(
      text
        .split("\n")
        .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );
    const additions: string[] = [];
    for (const entry of entries) {
      if (assigned.has(entry.name)) continue;
      if (entry.comment !== null) additions.push(`# ${entry.comment}`);
      additions.push(`${entry.name}=${entry.value}`);
      assigned.add(entry.name);
    }
    if (additions.length === 0) return text;
    const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
    const spacer = text === "" ? "" : "\n";
    return `${text}${prefix}${spacer}${additions.join("\n")}\n`;
  });
}

/**
 * Apply one structured edit. `current` is null when the file does not exist;
 * edits that need existing content (source anchors) conflict in that case.
 */
export function applyEdit(current: string | null, edit: StructuredEdit, path: string): string {
  switch (edit.kind) {
    case "json":
      return applyJsonEdit(current, edit.ops, path);
    case "managed-region":
      return upsertRegion(current, edit, path);
    case "lines":
      return appendMissingLines(current, edit.lines, edit.header);
    case "env":
      return addEnvEntries(current, edit.entries);
    case "source-anchor":
      if (current === null) {
        throw new TransformConflict(path, "the file to insert into does not exist");
      }
      return insertAtAnchor(current, edit, path);
  }
}

export { TransformConflict } from "./errors.ts";
export { findRegions, regionHash, removeRegion, upsertRegion } from "./regions.ts";
