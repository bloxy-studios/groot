/**
 * Mounting auth into the app's server entry with two source-anchor regions:
 *
 *   import { Hono } from "hono"        ← anchor 1 (unique)
 *   // groot:begin auth.imports …       imports of the recipe's route modules
 *   const app = new Hono()             ← anchor 2 (unique; multi-line OK)
 *   // groot:begin auth.routes …        app.route("/api/auth" | "/api/notes", …)
 *
 * Missing or ambiguous anchors are refused against the human's original text
 * (so the conflict cites their line numbers, not those of a preview that
 * already contains the import region). This module also reads what the
 * transform can't know: the app's variable name (from the declaration) and
 * the file's quote/semicolon style (so inserted lines read like the human's
 * code) — and refuses a declaration whose statement continues with chained
 * calls (`new Hono()\n  .use(…)`), which a region inserted after its first
 * line would split mid-expression.
 */
import type { StructuredEdit } from "../../contracts/plan.ts";
import { GrootV2Error } from "../../errors.ts";
import { findRegions } from "../../transforms/regions.ts";

export const IMPORT_ANCHOR = String.raw`^\s*import\s*\{[^}]*\bHono\b`;
export const DECLARATION_ANCHOR = String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*new\s+Hono\b`;
const DECLARATION_NAME = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

export const IMPORTS_REGION = "auth.imports";
export const ROUTES_REGION = "auth.routes";

export interface EntryStyle {
  readonly quote: "'" | '"';
  readonly semicolon: boolean;
}

export interface EntryAnalysis {
  readonly style: EntryStyle;
  /** The Hono app variable the routes mount on. */
  readonly appVar: string;
}

const DEFAULT_STYLE: EntryStyle = { quote: '"', semicolon: true };

/**
 * End line of the statement starting at `start`: balanced (), {}, [] outside
 * strings — the same boundary rule the source-anchor transform uses, so the
 * chained-call check below looks exactly where the region would land.
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
      else if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth--;
    }
    if (depth <= 0) return i;
  }
  return start;
}

function matchingLines(lines: readonly string[], pattern: string): number[] {
  const re = new RegExp(pattern);
  return lines.flatMap((line, index) => (re.test(line) ? [index] : []));
}

/**
 * The unique anchor line, or a conflict citing the human's own line numbers
 * (checked on the original text — once the import region is planned, the
 * transform would only see shifted lines).
 */
function anchorLine(
  lines: readonly string[],
  anchor: { pattern: string; description: string; regionId: string },
  path: string,
): number {
  const matches = matchingLines(lines, anchor.pattern);
  if (matches.length === 1) return matches[0] as number;
  const reason =
    matches.length === 0
      ? `could not find ${anchor.description} — groot needs exactly one match to insert "${anchor.regionId}" safely`
      : `found ${matches.length} candidates for ${anchor.description} (lines ${matches.map((line) => line + 1).join(", ")}) — refusing to guess`;
  throw new GrootV2Error("GROOT_E_CONFLICT", `${path}: ${reason}`, {
    hint: "Resolve the conflict in that file (or choose a different target), then plan again.",
    details: { path, conflict: "transform", reason },
  });
}

function styleOf(lines: readonly string[], importLine: number | null): EntryStyle {
  if (importLine === null) return DEFAULT_STYLE;
  const statement = lines.slice(importLine, statementEnd(lines, importLine) + 1).join("\n");
  return {
    quote: /from\s*'/.test(statement) ? "'" : '"',
    semicolon: statement.trimEnd().endsWith(";"),
  };
}

function regionsIn(text: string, path: string): Set<string> {
  try {
    return new Set(findRegions(text, path).map((region) => region.id));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GrootV2Error("GROOT_E_CONFLICT", reason, {
      details: { path, conflict: "transform", reason },
    });
  }
}

const IMPORT = {
  pattern: IMPORT_ANCHOR,
  description: 'the `import { Hono } from "hono"` statement',
  regionId: IMPORTS_REGION,
};
const DECLARATION = {
  pattern: DECLARATION_ANCHOR,
  description: "the `const app = new Hono()` declaration",
  regionId: ROUTES_REGION,
};

/**
 * Read what the mount needs from the entry and refuse anything unsafe: a
 * missing or ambiguous anchor, or a chained declaration. A region Groot
 * already placed is refreshed in place by the transform, so its anchor no
 * longer has to be unique.
 */
export function analyzeEntry(text: string, path: string): EntryAnalysis {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const placed = regionsIn(text, path);
  const importMatches = matchingLines(lines, IMPORT_ANCHOR);
  if (!placed.has(IMPORTS_REGION)) anchorLine(lines, IMPORT, path);
  const style = styleOf(lines, importMatches.length === 1 ? (importMatches[0] as number) : null);
  if (placed.has(ROUTES_REGION)) {
    const existing = matchingLines(lines, DECLARATION_ANCHOR);
    const line = existing.length === 1 ? lines[existing[0] as number] : undefined;
    return { style, appVar: DECLARATION_NAME.exec(line ?? "")?.[1] ?? "app" };
  }
  const declaration = anchorLine(lines, DECLARATION, path);
  const appVar = DECLARATION_NAME.exec(lines[declaration] as string)?.[1] ?? "app";
  const end = statementEnd(lines, declaration);
  const next = lines.slice(end + 1).find((line) => line.trim() !== "");
  if (next?.trim().startsWith(".")) {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${path}: the \`${appVar} = new Hono()\` declaration on line ${declaration + 1} continues with chained calls — inserting routes after it would split the expression.`,
      {
        hint: `End the declaration first (e.g. \`const ${appVar} = new Hono();\` then \`${appVar}.use(…)\` on its own lines), or mount the auth routes yourself, then plan again.`,
        details: { path, conflict: "transform", reason: "chained Hono declaration" },
      },
    );
  }
  return { style, appVar };
}

function statement(style: EntryStyle, code: string): string {
  return `${code.replace(/"/g, style.quote)}${style.semicolon ? ";" : ""}`;
}

export function importsEdit(style: EntryStyle): StructuredEdit {
  return {
    kind: "source-anchor",
    anchor: IMPORT.pattern,
    anchorDescription: IMPORT.description,
    position: "after-line",
    regionId: IMPORT.regionId,
    content: [
      statement(style, 'import { authRoutes } from "./http/auth-routes"'),
      statement(style, 'import { notesRoutes } from "./http/notes-routes"'),
    ].join("\n"),
    commentStyle: "slash",
  };
}

export function routesEdit(analysis: EntryAnalysis): StructuredEdit {
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
