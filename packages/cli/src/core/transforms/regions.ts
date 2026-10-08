/**
 * Managed text regions: Groot-owned blocks delimited by comment markers that
 * record the region id and a hash of the content Groot last wrote.
 *
 *   <!-- groot:begin project-context sha256:… -->
 *   …generated…
 *   <!-- groot:end project-context -->
 *
 * Human text outside regions is never touched — nor are its line endings or
 * its final newline. A region is Groot's only while a well-formed recorded
 * hash matches its content: an edited body, or a begin marker whose hash is
 * missing or malformed, is a conflict, never an overwrite. Source anchors
 * insert a region after (or before) the unique line matching a pattern; zero
 * or several matches, or a statement whose end can't be established, are
 * conflicts.
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

/**
 * Run a transform on LF text and re-emit its result with the file's own
 * (dominant) line ending, so a CRLF file stays CRLF. When nothing changed,
 * `current` itself is returned — callers detect a no-op by equality.
 */
export function preservingLineEndings(
  current: string | null,
  transform: (text: string) => string,
): string {
  const text = current ?? "";
  const lf = text.replace(/\r\n/g, "\n");
  const next = transform(lf);
  if (current !== null && next === lf) return current;
  return usesCrlf(text) ? next.replace(/\r?\n/g, "\r\n") : next;
}

/** True when most of the text's line breaks are CRLF. */
function usesCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  const breaks = text.split("\n").length - 1;
  return crlf > breaks - crlf;
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
  /** The hash recorded in the begin marker; null when it is missing or malformed. */
  readonly recordedHash: string | null;
  readonly body: string;
  readonly actualHash: string;
  /**
   * The body is exactly what Groot last wrote: a well-formed recorded hash
   * matches it. Without one Groot can't prove that, so the region counts as
   * edited by hand.
   */
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
      intact: recordedHash !== null && recordedHash === actualHash,
      beginLine: i,
      endLine: end,
    });
    i = end;
  }
  return regions;
}

/** The conflict for a region Groot can't prove is still its own. */
function editedRegion(match: RegionMatch, path: string): TransformConflict {
  return new TransformConflict(
    path,
    match.recordedHash === null
      ? `managed region "${match.id}" has no valid sha256 in its groot:begin marker, so groot cannot tell whether it was edited by hand — move your notes outside the groot:begin/end markers, delete the region, and re-run`
      : `managed region "${match.id}" was edited by hand since groot wrote it — move your edits outside the groot:begin/end markers (or delete the region) and re-run`,
  );
}

function renderRegion(style: CommentStyle, id: string, content: string): string[] {
  const body = normalizeBody(content);
  return [
    beginMarker(style, id, regionHash(body)),
    ...(body === "" ? [] : body.split("\n")),
    endMarker(style, id),
  ];
}

interface RegionEdit {
  readonly regionId: string;
  readonly content: string;
  readonly commentStyle: CommentStyle;
  readonly placement: "start" | "end";
}

/**
 * Create or replace a managed region. `placement` applies only when the
 * region is new: a blank line separates it from the human text, whose final
 * newline (or lack of one) is kept. A region Groot can't prove is its own is
 * a conflict.
 */
export function upsertRegion(current: string | null, options: RegionEdit, path: string): string {
  return preservingLineEndings(current, (text) => upsertLf(text, options, path));
}

function upsertLf(text: string, options: RegionEdit, path: string): string {
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
    if (!match.intact) throw editedRegion(match, path);
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
  const end = hasTrailingNewline ? "\n" : "";
  if (options.placement === "start") {
    return `${[...rendered, "", ...body].join("\n")}${end}`;
  }
  const separator = body.length > 0 && (body[body.length - 1] ?? "").trim() !== "" ? [""] : [];
  return `${[...body, ...separator, ...rendered].join("\n")}${end}`;
}

/**
 * Remove a managed region (rollback of a region-only change) together with
 * the blank line upsertRegion put between it and the human text, so upsert
 * then remove restores the original bytes. One case is inherently ambiguous:
 * text that already ended in a blank line got no separator, so removing a
 * region appended to it also drops that blank line. Conflict if edited.
 */
export function removeRegion(current: string, regionId: string, path: string): string {
  return preservingLineEndings(current, (text) => {
    const match = findRegions(text, path).find((region) => region.id === regionId);
    if (match === undefined) return text;
    if (!match.intact) throw editedRegion(match, path);
    const lines = text.split("\n");
    const before = lines.slice(0, match.beginLine);
    const after = lines.slice(match.endLine + 1);
    // Placed at the start: [region, "", …human]. Appended at the end: […human, "", region].
    const startSeparator = before.length === 0 && after.length > 1 && after[0] === "";
    const endSeparator =
      !startSeparator &&
      (after.length === 0 || (after.length === 1 && after[0] === "")) &&
      before.length > 1 &&
      before[before.length - 1] === "" &&
      (before[before.length - 2] ?? "").trim() !== "";
    return [
      ...(endSeparator ? before.slice(0, -1) : before),
      ...(startSeparator ? after.slice(1) : after),
    ].join("\n");
  });
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
  return preservingLineEndings(current, (text) => {
    const existing = findRegions(text, path).find((region) => region.id === options.regionId);
    if (existing !== undefined || options.position === "end-of-file") {
      return upsertLf(text, { ...options, placement: "end" }, path);
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
      options.position === "after-line" ? statementEnd(lines, anchorLine, path) + 1 : anchorLine;
    return [...lines.slice(0, insertAt), ...rendered, ...lines.slice(insertAt)].join("\n");
  });
}

/** A line whose last code character is one of these continues on the next line. */
const CONTINUES_AFTER = new Set([
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "<",
  ">",
  "?",
  ":",
  ",",
  ".",
]);

/** A code line starting like this continues the previous one (`.` but not a `...` spread). */
const CONTINUES_BEFORE = /^(?:\?\.|\.(?!\.\.)|[-+*/%&|^<>=?:,])/;

/**
 * For `after-line`: the last line of the statement that starts on the anchor
 * line — brackets balanced outside strings and comments, and not continued
 * on the next code line (a chained call, a trailing or leading operator).
 * Anything the scan cannot settle is a conflict, never a guess, so the region
 * is never inserted mid-expression.
 */
function statementEnd(lines: readonly string[], start: number, path: string): number {
  let depth = 0;
  let quote: string | null = null;
  let block = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    let last = "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c] as string;
      if (block) {
        if (ch === "*" && line[c + 1] === "/") {
          block = false;
          c++;
        }
        continue;
      }
      if (quote !== null) {
        if (ch === "\\") c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === "/" && line[c + 1] === "*") {
        block = true;
        c++;
        continue;
      }
      if (ch.trim() !== "") last = ch;
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth > 0 || quote !== null || block) continue;
    const next = nextCodeLine(lines, i + 1);
    if (
      CONTINUES_AFTER.has(last) ||
      (next !== null && CONTINUES_BEFORE.test((lines[next] as string).trim()))
    ) {
      throw new TransformConflict(
        path,
        `the statement starting on line ${start + 1} continues on line ${(next ?? i) + 1} — refusing to insert mid-expression`,
      );
    }
    return i;
  }
  throw new TransformConflict(
    path,
    `could not find where the statement on line ${start + 1} ends — refusing to guess`,
  );
}

/** Index of the next line holding code (blank and comment-only lines skipped), or null. */
function nextCodeLine(lines: readonly string[], from: number): number | null {
  let block = false;
  for (let i = from; i < lines.length; i++) {
    let rest = (lines[i] as string).trim();
    while (rest !== "") {
      if (block) {
        const close = rest.indexOf("*/");
        if (close === -1) {
          rest = "";
          break;
        }
        block = false;
        rest = rest.slice(close + 2).trim();
      } else if (rest.startsWith("//")) {
        rest = "";
      } else if (rest.startsWith("/*")) {
        block = true;
        rest = rest.slice(2);
      } else {
        return i;
      }
    }
  }
  return null;
}
