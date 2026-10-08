/**
 * A small TypeScript source scanner for mounting regions into a server entry.
 * It reads code only: comments and the contents of string and template
 * literals are blanked out (line breaks kept, so line numbers hold), which
 * lets the mount find where a statement really ends and what comes after it —
 * an apostrophe in a JSDoc or a brace in a string can't mislead it.
 *
 * Regex literals are not recognized (a quote or bracket inside one would be
 * misread); the entry's own declarations don't use them, and every planned
 * entry is also re-parsed before Groot accepts it.
 */

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
 * inserts no semicolon before `.`, `?.`, `(`, `[`, a template, or an operator.
 */
const CONTINUATION_START = /^(?:\.|\?|[([`,*%^|&>=])/;

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
