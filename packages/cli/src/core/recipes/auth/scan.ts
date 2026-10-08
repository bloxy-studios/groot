/**
 * A small TypeScript source scanner for mounting regions into a server entry.
 * It reads code only: comments and the contents of string, template and
 * regular expression literals are blanked out (line breaks kept, so line
 * numbers hold), which lets the mount find where a statement really ends and
 * what comes after it — an apostrophe in a JSDoc, a brace in a string or a
 * bracket in a regex can't mislead it.
 *
 * A `/` starts a regular expression only where an operand is expected (after
 * an operator, an opening bracket, `=>`, or a keyword like `return`) and the
 * literal closes on its line; after a value (a name, a number, `)`, `]`, `}`)
 * it divides. A heuristic can still misread exotic code, so every planned entry
 * is also re-parsed, and each new region must stand between top-level
 * statements (./entry.ts), before Groot accepts it.
 */

/** Keywords after which a `/` starts a regular expression rather than dividing. */
const REGEX_AFTER = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Code characters after which an operand (and so a regular expression) is expected. */
const OPERAND_EXPECTED = "(,=:[!&|?{};+-*%~^>";

/**
 * Can a `/` start a regular expression after the code read so far? Not after
 * a value — a property named like a keyword (`o.return`) is one — and never
 * after `<`: in TSX, `</` closes a tag.
 */
function regexMayStart(out: readonly string[]): boolean {
  let i = out.length - 1;
  while (i >= 0 && (out[i] as string).trim() === "") i--;
  if (i < 0) return true;
  const last = out[i] as string;
  if (!/[\w$]/.test(last)) return OPERAND_EXPECTED.includes(last);
  let start = i;
  while (start > 0 && /[\w$]/.test(out[start - 1] as string)) start--;
  return out[start - 1] !== "." && REGEX_AFTER.has(out.slice(start, i + 1).join(""));
}

/** Index of the `/` closing the regular expression that opens at `start`, or null when none closes on its line. */
function regexClose(text: string, start: number): number | null {
  const lineBreak = (ch: string | undefined): boolean => ch === "\n" || ch === "\r";
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      if (lineBreak(text[i])) return null;
    } else if (lineBreak(ch)) {
      return null;
    } else if (inClass) {
      inClass = ch !== "]";
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      return i;
    }
  }
  return null;
}

/** `text` with comments and literal contents replaced by spaces; line breaks are kept. */
export function codeOnly(text: string): string {
  const out: string[] = [];
  /** Brace depth inside each open `${ … }` of the enclosing template literals. */
  const holes: number[] = [];
  let inTemplate = false;
  let i = 0;
  const blank = (to: number): void => {
    for (; i < to; i++) out.push(text[i] === "\n" ? "\n" : " ");
  };
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inTemplate) {
      if (ch === "\\") blank(Math.min(i + 2, text.length));
      else if (ch === "`") {
        out.push(ch);
        i++;
        inTemplate = false;
      } else if (ch === "$" && next === "{") {
        blank(i + 2);
        holes.push(0);
        inTemplate = false;
      } else blank(i + 1);
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      blank(end === -1 ? text.length : end);
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      blank(end === -1 ? text.length : end + 2);
    } else if (ch === "/" && regexMayStart(out)) {
      const close = regexClose(text, i);
      out.push(ch);
      i++;
      if (close !== null) {
        blank(close);
        out.push("/");
        i++;
      }
    } else if (ch === '"' || ch === "'") {
      out.push(ch);
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== "\n") {
        blank(text[i] === "\\" && text[i + 1] !== "\n" ? i + 2 : i + 1);
      }
      if (text[i] === ch) {
        out.push(ch);
        i++;
      }
    } else if (ch === "`") {
      out.push(ch);
      i++;
      inTemplate = true;
    } else if (holes.length > 0 && (ch === "{" || ch === "}")) {
      const depth = holes[holes.length - 1] as number;
      if (ch === "}" && depth === 0) {
        holes.pop();
        blank(i + 1);
        inTemplate = true;
      } else {
        holes[holes.length - 1] = depth + (ch === "{" ? 1 : -1);
        out.push(ch);
        i++;
      }
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join("");
}

/** Lines of `text` (CRLF or LF), code only. */
export function codeLines(text: string): string[] {
  return codeOnly(text.replace(/\r\n/g, "\n")).split("\n");
}

/**
 * Last line of the statement that starts on `start`: the first line where the
 * (), {}, [] opened since `start` are balanced again — null when they never
 * are (the statement can't be read safely).
 */
export function statementEnd(code: readonly string[], start: number): number | null {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    for (const ch of code[i] as string) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth <= 0) return i;
  }
  return null;
}

/** A line ending in one of these continues on the next one (`,`, `=`, `=>`, binary operators, `.`). */
const OPEN_END = /[,=+\-*/%&|^?:.]$/;
/**
 * A line starting with one of these continues the previous expression — JS
 * inserts no semicolon before `.`, `?.`, `(`, `[`, a template, or an operator
 * (`/` included: a regular expression there divides the line before).
 */
const CONTINUATION_START = /^(?:\.|\?|[([`,*/%^|&>=])/;

/**
 * Where the statement ending on line `end` continues, if it does: the line
 * that carries it on (`end` itself when it ends in an operator or comma), or
 * null when the statement is complete. Blank and comment-only lines between
 * are skipped — a formatter keeps comments inside member chains.
 */
export function continuationAfter(code: readonly string[], end: number): number | null {
  const last = (code[end] ?? "").trimEnd();
  if (last.endsWith(";")) return null;
  if (OPEN_END.test(last)) return end;
  for (let i = end + 1; i < code.length; i++) {
    const line = (code[i] as string).trim();
    if (line === "") continue;
    return CONTINUATION_START.test(line) ? i : null;
  }
  return null;
}
