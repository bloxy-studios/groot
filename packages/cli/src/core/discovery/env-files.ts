/**
 * Environment files: discovery reports which `.env*` files a unit has and
 * the variable NAMES they assign — never values. The parser keeps only the
 * name capture of each assignment; values are skipped, so nothing secret can
 * reach an observation, a plan, or agent context through discovery.
 *
 * Assignments are read the way Bun's own .env loader reads them: `KEY=value`
 * or `KEY: value` (a colon then whitespace — `KEY:` ending a line takes the
 * next line as its value), optionally after `export`; an empty value takes a
 * quoted value opening on the next non-blank line; inside any quotes a
 * backslash escapes the next character; `\r\n`, `\n`, and a lone `\r` end a
 * line.
 *
 * Lines inside a value are never mistaken for assignments: a quoted value
 * spanning lines is skipped through its closing quote (whatever its key looks
 * like), an armored block (`-----BEGIN …` through `-----END …`, e.g. a PEM key
 * pasted without quotes) is skipped whole, and a line whose "value" starts
 * with another `=` (a base64 padding tail such as `kQ29uZg==`) is not an
 * assignment. Where Bun would read more — the lines after a quote that never
 * closes, a key that is not an identifier — groot reports fewer names: it may
 * miss a name, never report a value.
 */
import { hasPublicPrefix } from "../env.ts";
import type { ProjectFs } from "./fs.ts";

export interface EnvVariable {
  name: string;
  file: string;
  publicPrefix: boolean;
}

export interface EnvFindings {
  readonly files: string[];
  readonly variables: EnvVariable[];
}

/** `.env` and `.env.<anything>` (not `.envrc`, a direnv shell script). */
const ENV_FILE = /^\.env(?:\..+)?$/;
/** A key and its separator, optionally after `export`; dotenv also accepts `.` and `-` in keys. */
const KEY = /^\s*(?:export\s+)?([\w.-]+)[ \t]*([=:])(.*)$/s;
/** After `KEY:` Bun's loader needs one whitespace character (a line break counts too). */
const COLON_SPACE = /^[ \t\v\f]/;
/** Line breaks as Bun's loader sees them — captured, since `KEY:` depends on which one. */
const LINE_BREAK = /(\r\n|\r|\n)/;
/** The only keys reported as variable names. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARMOR_BEGIN = "-----BEGIN ";
const ARMOR_END = "-----END ";
const MAX_ENV_BYTES = 256 * 1024;

interface Assignment {
  readonly name: string;
  /** The value text on this line, leading blanks removed ("" when the value is on the next line). */
  readonly value: string;
  /** A base64 padding tail (`xyz==`) reads as `xyz` = `=`: no assignment a human wrote. */
  readonly paddingTail: boolean;
  /** `KEY:` ended by `\n` or a lone `\r`: Bun's loader reads the whole next line as the value. */
  readonly valueOnNextLine: boolean;
}

/** The assignment a line makes, given the line break ending it ("" at the end of the text). */
function assignment(line: string, lineBreak: string): Assignment | null {
  const match = KEY.exec(line);
  if (match === null) return null;
  const name = match[1] as string;
  const rest = match[3] as string;
  if (match[2] === "=") {
    const value = rest.replace(/^[ \t]+/, "");
    return { name, value, paddingTail: value.startsWith("="), valueOnNextLine: false };
  }
  if (rest === "") {
    // The line break is the colon's whitespace: after \r\n the value is empty (the \n ends it).
    if (lineBreak === "") return null;
    return { name, value: "", paddingTail: false, valueOnNextLine: lineBreak !== "\r\n" };
  }
  if (!COLON_SPACE.test(rest)) return null;
  const value = rest.slice(1).replace(/^[ \t]+/, "");
  return { name, value, paddingTail: false, valueOnNextLine: false };
}

/** Index of the first unescaped `quote` in `text` from `from` on, or -1. */
function quoteEnd(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Does unquoted text (inline ` # comment` ignored) open an armored block it does not close? */
function opensArmor(text: string): boolean {
  const code = text.replace(/(?:^|\s)#.*$/, "");
  const begin = code.lastIndexOf(ARMOR_BEGIN);
  return begin !== -1 && !code.includes(ARMOR_END, begin);
}

/** Where the next line sits relative to a value. */
interface ValueState {
  /** Inside a quoted value: the quote that closes it. */
  readonly quote: string | null;
  /** Inside an armored block, until a `-----END …` line. */
  readonly armor: boolean;
  /**
   * A value still to come. "line": the previous line was `KEY:`, so the next
   * non-blank line is the value. "quote": the value was empty, and Bun's
   * loader skips blank lines looking for an opening quote — a quoted value
   * opening on the next non-blank line belongs to that key.
   */
  readonly pending: "line" | "quote" | null;
}

const OUTSIDE: ValueState = { quote: null, armor: false, pending: null };

/** The state after a value starting with `value` (leading blanks removed). */
function afterValue(value: string): ValueState {
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    return { ...OUTSIDE, quote: quoteEnd(value, quote, 1) === -1 ? quote : null };
  }
  return { ...OUTSIDE, armor: opensArmor(value) };
}

/** The state after `line` when a value is pending, or null when the line is not that value. */
function pendingValue(line: string, pending: "line" | "quote"): ValueState | null {
  const text = line.replace(/^[ \t]+/, "");
  if (text === "") return { ...OUTSIDE, pending: "quote" }; // blank: still looking for a quote
  return pending === "line" || /^["'`]/.test(text) ? afterValue(text) : null;
}

/** Variable names assigned in dotenv text, in first-appearance order. */
export function envNames(text: string): string[] {
  const names: string[] = [];
  const parts = text.split(LINE_BREAK);
  let state = OUTSIDE;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] as string;
    if (state.quote !== null) {
      if (quoteEnd(line, state.quote, 0) !== -1) state = OUTSIDE;
      continue;
    }
    if (state.armor) {
      if (line.includes(ARMOR_END)) state = { ...OUTSIDE, armor: opensArmor(line) }; // a chained block may open here
      continue;
    }
    const value = state.pending === null ? null : pendingValue(line, state.pending);
    if (value !== null) {
      state = value;
      continue;
    }
    const found = assignment(line, parts[index + 1] ?? "");
    if (found === null) {
      state = { ...OUTSIDE, armor: opensArmor(line) };
      continue;
    }
    if (found.valueOnNextLine) state = { ...OUTSIDE, pending: "line" };
    else state = found.value === "" ? { ...OUTSIDE, pending: "quote" } : afterValue(found.value);
    if (IDENTIFIER.test(found.name) && !found.paddingTail && !names.includes(found.name)) {
      names.push(found.name);
    }
  }
  return names;
}

/** `.env*` files directly inside a unit directory and the names they assign. */
export async function envFindings(fs: ProjectFs, unitPath: string): Promise<EnvFindings> {
  const entries = await fs.list(unitPath);
  const files = entries
    .filter((entry) => entry.type === "file" && ENV_FILE.test(entry.name))
    .map((entry) => entry.path);
  const variables: EnvVariable[] = [];
  for (const file of files) {
    const content = await fs.readText(file, MAX_ENV_BYTES);
    if (content === null) continue;
    for (const name of envNames(content.text).sort()) {
      variables.push({ name, file, publicPrefix: hasPublicPrefix(name) });
    }
  }
  return { files, variables };
}
