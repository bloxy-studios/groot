/**
 * Managed text regions: Groot-owned blocks delimited by comment markers that
 * record the region id and a hash of the content Groot last wrote.
 *
 *   <!-- groot:begin project-context sha256:… -->
 *   …generated…
 *   <!-- groot:end project-context -->
 *
 * Human text outside regions is never touched. A region whose content no
 * longer matches its recorded hash was edited by a human → conflict, never an
 * overwrite. Source anchors insert a region after (or before) the unique line
 * matching a pattern; zero or several matches are conflicts.
 */
import type { CommentStyle } from "../contracts/plan.ts";
import { sha256Of } from "../fs/hash.ts";
import { TransformConflict } from "./errors.ts";

const COMMENT: Record<CommentStyle, { open: string; close: string }> = {
  html: { open: "<!-- ", close: " -->" },
  hash: { open: "# ", close: "" },
  slash: { open: "// ", close: "" },
};

export function beginMarker(style: CommentStyle, id: string, hash: string): string {
  const { open, close } = COMMENT[style];
  return `${open}groot:begin ${id} ${hash}${close}`;
}

export function endMarker(style: CommentStyle, id: string): string {
  const { open, close } = COMMENT[style];
  return `${open}groot:end ${id}${close}`;
}

/** Normalize region content: no trailing newline inside, LF endings. */
function normalizeBody(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function regionHash(content: string): string {
  return sha256Of(normalizeBody(content));
}

export interface RegionMatch {
  readonly id: string;
  readonly recordedHash: string | null;
  readonly body: string;
  readonly actualHash: string;
  readonly intact: boolean;
  /** Line indexes of the begin and end markers. */
  readonly beginLine: number;
  readonly endLine: number;
}

const BEGIN_RE = /groot:begin ([a-z0-9][a-z0-9-.]*)(?: (sha256:[0-9a-f]{64}))?/;
const END_RE = /groot:end ([a-z0-9][a-z0-9-.]*)/;

/** Find every managed region in a text (any comment style). */
export function findRegions(text: string, path = "(text)"): RegionMatch[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const regions: RegionMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = BEGIN_RE.exec(lines[i] as string);
    if (begin === null) continue;
    const id = begin[1] as string;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const endMatch = END_RE.exec(lines[j] as string);
      if (endMatch !== null && endMatch[1] === id) {
        end = j;
        break;
      }
      if (BEGIN_RE.test(lines[j] as string)) break;
    }
    if (end === -1) {
      throw new TransformConflict(path, `managed region "${id}" has no matching end marker`);
    }
    const body = lines.slice(i + 1, end).join("\n");
    const actualHash = regionHash(body);
    const recordedHash = begin[2] ?? null;
    regions.push({
      id,
      recordedHash,
      body,
      actualHash,
      intact: recordedHash === null || recordedHash === actualHash,
      beginLine: i,
      endLine: end,
    });
    i = end;
  }
  return regions;
}

function renderRegion(style: CommentStyle, id: string, content: string): string[] {
  const body = normalizeBody(content);
  return [
    beginMarker(style, id, regionHash(body)),
    ...(body === "" ? [] : body.split("\n")),
    endMarker(style, id),
  ];
}

/**
 * Create or replace a managed region. `placement` applies only when the
 * region is new. A human-edited region is a conflict.
 */
export function upsertRegion(
  current: string | null,
  options: {
    regionId: string;
    content: string;
    commentStyle: CommentStyle;
    placement: "start" | "end";
  },
  path: string,
): string {
  const text = (current ?? "").replace(/\r\n/g, "\n");
  const existing = findRegions(text, path).filter((region) => region.id === options.regionId);
  if (existing.length > 1) {
    throw new TransformConflict(
      path,
      `managed region "${options.regionId}" appears more than once`,
    );
  }
  const rendered = renderRegion(options.commentStyle, options.regionId, options.content);
  const lines = text === "" ? [] : text.split("\n");
  const match = existing[0];
  if (match !== undefined) {
    if (!match.intact) {
      throw new TransformConflict(
        path,
        `managed region "${options.regionId}" was edited by hand since groot wrote it — move your edits outside the groot:begin/end markers (or delete the region) and re-run`,
      );
    }
    const next = [
      ...lines.slice(0, match.beginLine),
      ...rendered,
      ...lines.slice(match.endLine + 1),
    ];
    return next.join("\n");
  }
  if (lines.length === 0) return `${rendered.join("\n")}\n`;
  const hasTrailingNewline = text.endsWith("\n");
  const body = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (options.placement === "start") {
    return `${[...rendered, "", ...body].join("\n")}\n`;
  }
  const separator = body.length > 0 && (body[body.length - 1] ?? "").trim() !== "" ? [""] : [];
  return `${[...body, ...separator, ...rendered].join("\n")}\n`;
}

/** Remove a managed region (rollback of a region-only change). Conflict if edited. */
export function removeRegion(current: string, regionId: string, path: string): string {
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const match = findRegions(current, path).find((region) => region.id === regionId);
  if (match === undefined) return current;
  if (!match.intact) {
    throw new TransformConflict(path, `managed region "${regionId}" was edited by hand`);
  }
  const next = [...lines.slice(0, match.beginLine), ...lines.slice(match.endLine + 1)];
  return next.join("\n");
}

/**
 * Insert (or refresh) a managed region next to the unique line matching
 * `anchor`. `end-of-file` ignores the anchor and appends.
 */
export function insertAtAnchor(
  current: string,
  options: {
    anchor: string;
    anchorDescription: string;
    position: "after-line" | "before-line" | "end-of-file";
    regionId: string;
    content: string;
    commentStyle: CommentStyle;
  },
  path: string,
): string {
  const text = current.replace(/\r\n/g, "\n");
  const existing = findRegions(text, path).find((region) => region.id === options.regionId);
  if (existing !== undefined) {
    return upsertRegion(text, { ...options, placement: "end" }, path);
  }
  if (options.position === "end-of-file") {
    return upsertRegion(text, { ...options, placement: "end" }, path);
  }
  const pattern = new RegExp(options.anchor, "m");
  const lines = text.split("\n");
  const matches = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
  if (matches.length === 0) {
    throw new TransformConflict(
      path,
      `could not find ${options.anchorDescription} — groot needs exactly one match to insert "${options.regionId}" safely`,
    );
  }
  if (matches.length > 1) {
    throw new TransformConflict(
      path,
      `found ${matches.length} candidates for ${options.anchorDescription} (lines ${matches.map((m) => m + 1).join(", ")}) — refusing to guess`,
    );
  }
  const anchorLine = matches[0] as number;
  const rendered = renderRegion(options.commentStyle, options.regionId, options.content);
  const insertAt =
    options.position === "after-line" ? statementEnd(lines, anchorLine) + 1 : anchorLine;
  return [...lines.slice(0, insertAt), ...rendered, ...lines.slice(insertAt)].join("\n");
}

/**
 * For `after-line`, extend past a multi-line statement that starts on the
 * anchor line (balanced (), {}, [] outside strings) so the region is never
 * inserted mid-expression.
 */
function statementEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c] as string;
      if (quote !== null) {
        if (ch === "\\") c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth <= 0) return i;
  }
  return start;
}
