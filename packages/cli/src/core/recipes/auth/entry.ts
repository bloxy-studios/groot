/**
 * Mounting auth into the app's server entry with two source-anchor regions:
 *
 *   import { Hono } from "hono"        ← anchor 1 (unique; a formatter's
 *                                         multi-line import anchors on its
 *                                         closing `} from "hono"` line)
 *   // groot:begin auth.imports …       imports of the recipe's route modules
 *   const app = new Hono()             ← anchor 2 (unique; multi-line OK)
 *   // groot:begin auth.routes …        app.route("/api/auth" | "/api/notes", …)
 *
 * Missing or ambiguous anchors are refused against the human's original text
 * (so the conflict cites their line numbers, not those of a preview that
 * already contains the import region). This module also reads what the
 * transform can't know: the app's variable name (from the declaration) and
 * the file's quote/semicolon style (so inserted lines read like the human's
 * code). It reads code, not raw text (./scan.ts), so comments and strings
 * can't mislead it: a declaration whose statement continues past its end
 * (`new Hono()`, then `.use(…)` — comments in between or not) is refused,
 * because a region inserted after it would split the expression. Once the
 * regions are planned, each new one must start right after its anchor's
 * statement, and the entry must still parse — otherwise the plan is refused.
 */
import type { StructuredEdit } from "../../contracts/plan.ts";
import { GrootV2Error } from "../../errors.ts";
import { findRegions, type RegionMatch } from "../../transforms/regions.ts";
import { codeLines, continuationAfter, statementEnd } from "./scan.ts";

export const IMPORT_ANCHOR = String.raw`^\s*import\s*\{[^}]*\bHono\b`;
/** Closing line of a multi-line import from "hono" (`import {\n  Hono,\n} from "hono"`). */
export const IMPORT_CLOSE_ANCHOR = String.raw`^\s*\}\s*from\s*["']hono["']`;
export const DECLARATION_ANCHOR = String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*new\s+Hono\b`;
const DECLARATION_NAME = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

export const IMPORTS_REGION = "auth.imports";
export const ROUTES_REGION = "auth.routes";

export type SourceAnchorEdit = Extract<StructuredEdit, { kind: "source-anchor" }>;

export interface EntryStyle {
  readonly quote: "'" | '"';
  readonly semicolon: boolean;
}

interface Anchor {
  readonly pattern: string;
  readonly description: string;
  readonly regionId: string;
}

export interface EntryAnalysis {
  readonly style: EntryStyle;
  /** The Hono app variable the routes mount on. */
  readonly appVar: string;
  /** Where the imports region goes: the one-line import, or a multi-line import's closing line. */
  readonly importAnchor: Anchor;
  /** The routes region already exists (it is refreshed where it stands, wherever the human moved it). */
  readonly routesPlaced: boolean;
}

const DEFAULT_STYLE: EntryStyle = { quote: '"', semicolon: true };

const IMPORT: Anchor = {
  pattern: IMPORT_ANCHOR,
  description: 'the `import { Hono } from "hono"` statement',
  regionId: IMPORTS_REGION,
};
const IMPORT_CLOSE: Anchor = {
  pattern: IMPORT_CLOSE_ANCHOR,
  description: 'the closing `} from "hono"` line of the multi-line Hono import',
  regionId: IMPORTS_REGION,
};
const DECLARATION: Anchor = {
  pattern: DECLARATION_ANCHOR,
  description: "the `const app = new Hono()` declaration",
  regionId: ROUTES_REGION,
};

function linesOf(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function matchingLines(lines: readonly string[], pattern: string): number[] {
  const re = new RegExp(pattern);
  return lines.flatMap((line, index) => (re.test(line) ? [index] : []));
}

function conflict(path: string, reason: string, hint: string, detail: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_CONFLICT", `${path}: ${reason}`, {
    hint,
    details: { path, conflict: "transform", reason: detail },
  });
}

function anchorConflict(anchor: Anchor, matches: readonly number[], path: string): GrootV2Error {
  const reason =
    matches.length === 0
      ? `could not find ${anchor.description} — groot needs exactly one match to insert "${anchor.regionId}" safely`
      : `found ${matches.length} candidates for ${anchor.description} (lines ${matches.map((line) => line + 1).join(", ")}) — refusing to guess`;
  return new GrootV2Error("GROOT_E_CONFLICT", `${path}: ${reason}`, {
    hint: "Resolve the conflict in that file (or choose a different target), then plan again.",
    details: { path, conflict: "transform", reason },
  });
}

/**
 * The unique anchor line, or a conflict citing the human's own line numbers
 * (checked on the original text — once the import region is planned, the
 * transform would only see shifted lines).
 */
function anchorLine(lines: readonly string[], anchor: Anchor, path: string): number {
  const matches = matchingLines(lines, anchor.pattern);
  if (matches.length === 1) return matches[0] as number;
  throw anchorConflict(anchor, matches, path);
}

/** The Hono import: the anchor its region hangs off and the lines the statement spans. */
interface ImportSite {
  readonly anchor: Anchor;
  readonly start: number;
  readonly end: number;
}

/** First line of the import statement that closes on line `end` (null: not an import). */
function importStart(code: readonly string[], end: number): number | null {
  for (let i = end; i >= 0; i--) {
    const line = code[i] as string;
    if (/^\s*import\b/.test(line)) return i;
    if (i < end && /;|\bfrom\b|^\s*export\b/.test(line)) return null;
  }
  return null;
}

function locateHonoImport(
  lines: readonly string[],
  code: readonly string[],
  path: string,
): ImportSite {
  if (matchingLines(lines, IMPORT_ANCHOR).length > 0) {
    const start = anchorLine(lines, IMPORT, path);
    return { anchor: IMPORT, start, end: statementEnd(code, start) ?? start };
  }
  // A formatter's multi-line import names Hono on a line of its own.
  const withHono = matchingLines(lines, IMPORT_CLOSE_ANCHOR).filter((end) => {
    const start = importStart(code, end);
    return start !== null && /\bHono\b/.test(code.slice(start, end + 1).join("\n"));
  });
  if (withHono.length === 0) throw anchorConflict(IMPORT, [], path);
  const end = anchorLine(lines, IMPORT_CLOSE, path);
  return { anchor: IMPORT_CLOSE, start: importStart(code, end) ?? end, end };
}

function styleOf(code: readonly string[], site: ImportSite | null): EntryStyle {
  if (site === null) return DEFAULT_STYLE;
  // Literal contents are blanked in the code view, but quote characters and semicolons remain.
  const statement = code.slice(site.start, site.end + 1).join("\n");
  return {
    quote: /from\s*'/.test(statement) ? "'" : '"',
    semicolon: statement.trimEnd().endsWith(";"),
  };
}

function regionsIn(text: string, path: string): RegionMatch[] {
  try {
    return findRegions(text, path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GrootV2Error("GROOT_E_CONFLICT", reason, {
      details: { path, conflict: "transform", reason },
    });
  }
}

function placedIn(text: string, path: string): Set<string> {
  return new Set(regionsIn(text, path).map((region) => region.id));
}

/** Refuse a declaration whose statement goes on past its last line — a region there would split it. */
function assertDeclarationEnds(
  lines: readonly string[],
  code: readonly string[],
  declaration: number,
  path: string,
): void {
  const appVar = DECLARATION_NAME.exec(lines[declaration] as string)?.[1] ?? "app";
  const end = statementEnd(code, declaration);
  let how = "never closes its brackets";
  if (end !== null) {
    const next = continuationAfter(code, end);
    if (next === null) return;
    how =
      next === end
        ? `continues past line ${end + 1}`
        : /^\s*\??\./.test(code[next] as string)
          ? `continues with chained calls (line ${next + 1})`
          : `continues on line ${next + 1}`;
  }
  throw conflict(
    path,
    `the \`${appVar} = new Hono()\` declaration on line ${declaration + 1} ${how} — inserting routes after it would split the expression.`,
    `End the declaration first (e.g. \`const ${appVar} = new Hono();\` then \`${appVar}.use(…)\` on its own lines), or mount the auth routes yourself, then plan again.`,
    "chained Hono declaration",
  );
}

/**
 * Read what the mount needs from the entry and refuse anything unsafe: a
 * missing or ambiguous anchor, or a declaration that continues past its end.
 * A region Groot already placed is refreshed in place by the transform, so its
 * anchor no longer has to be unique.
 */
export function analyzeEntry(text: string, path: string): EntryAnalysis {
  const lines = linesOf(text);
  const code = codeLines(text);
  const placed = placedIn(text, path);
  let site: ImportSite | null = null;
  try {
    site = locateHonoImport(lines, code, path);
  } catch (error) {
    if (!placed.has(IMPORTS_REGION)) throw error;
  }
  const style = styleOf(code, site);
  const importAnchor = site?.anchor ?? IMPORT;
  if (placed.has(ROUTES_REGION)) {
    const existing = matchingLines(lines, DECLARATION_ANCHOR);
    const line = existing.length === 1 ? lines[existing[0] as number] : undefined;
    const appVar = DECLARATION_NAME.exec(line ?? "")?.[1] ?? "app";
    return { style, importAnchor, appVar, routesPlaced: true };
  }
  const declaration = anchorLine(lines, DECLARATION, path);
  assertDeclarationEnds(lines, code, declaration, path);
  const appVar = DECLARATION_NAME.exec(lines[declaration] as string)?.[1] ?? "app";
  return { style, appVar, importAnchor, routesPlaced: false };
}

function statement(style: EntryStyle, code: string): string {
  return `${code.replace(/"/g, style.quote)}${style.semicolon ? ";" : ""}`;
}

export function importsEdit(analysis: EntryAnalysis): SourceAnchorEdit {
  const { style, importAnchor } = analysis;
  return {
    kind: "source-anchor",
    anchor: importAnchor.pattern,
    anchorDescription: importAnchor.description,
    position: "after-line",
    regionId: importAnchor.regionId,
    content: [
      statement(style, 'import { authRoutes } from "./http/auth-routes"'),
      statement(style, 'import { notesRoutes } from "./http/notes-routes"'),
    ].join("\n"),
    commentStyle: "slash",
  };
}

export function routesEdit(analysis: EntryAnalysis): SourceAnchorEdit {
  const { style, appVar } = analysis;
  return {
    kind: "source-anchor",
    anchor: DECLARATION.pattern,
    anchorDescription: DECLARATION.description,
    position: "after-line",
    regionId: DECLARATION.regionId,
    content: [
      statement(style, `${appVar}.route("/api/auth", authRoutes)`),
      statement(style, `${appVar}.route("/api/notes", notesRoutes)`),
    ].join("\n"),
    commentStyle: "slash",
  };
}

/** Line a new after-line region must start on: right after its anchor's statement (null: unreadable). */
function insertionLine(text: string, anchor: string): number | null {
  const matches = matchingLines(linesOf(text), anchor);
  if (matches.length !== 1) return null;
  const end = statementEnd(codeLines(text), matches[0] as number);
  return end === null ? null : end + 1;
}

/**
 * Confirm that a region the transform just inserted (`before` → `after`)
 * starts right after its anchor's statement as this module reads it. The
 * transform finds that boundary on its own; when the two readings differ, the
 * statement can't be read safely, so the plan is refused rather than risking
 * a region inside it. A region that already existed was refreshed in place.
 */
export function assertMountedAfterStatement(
  before: string,
  after: string,
  edit: SourceAnchorEdit,
  path: string,
): void {
  if (placedIn(before, path).has(edit.regionId)) return;
  const expected = insertionLine(before, edit.anchor);
  const landed = regionsIn(after, path).find((region) => region.id === edit.regionId)?.beginLine;
  if (expected !== null && landed === expected) return;
  throw conflict(
    path,
    `groot could not place "${edit.regionId}" safely after ${edit.anchorDescription} — where that statement ends can't be read unambiguously (a quote or bracket inside a comment?).`,
    "Simplify the statement (e.g. move comments out of it), or add the lines yourself, then plan again.",
    "region placement",
  );
}

function parses(text: string, path: string): boolean {
  try {
    new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(text);
    return true;
  } catch {
    return false;
  }
}

/** Safety net: refuse a planned entry that no longer parses (when the human's own version did). */
export function assertStillParses(original: string, planned: string, path: string): void {
  if (planned === original || parses(planned, path) || !parses(original, path)) return;
  throw conflict(
    path,
    "with the auth regions inserted, the entry would no longer parse — refusing to write it.",
    "Mount the auth routes yourself (see the auth.routes decision), or simplify the entry around the Hono import and declaration, then plan again.",
    "unparseable result",
  );
}
