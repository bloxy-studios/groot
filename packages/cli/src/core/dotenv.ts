/**
 * What Bun loads from a dotenv file, read the way Bun's own loader reads it
 * (Bun 1.4; the parser behind both `.env` loading and util.parseEnv), so Groot
 * can tell whether the app will actually see a value — recipes planning env
 * files, and the env and credential checks deciding whether a variable is set:
 *
 * - `KEY=value` and `KEY: value`, optionally after `export`;
 * - single, double or backtick quotes: the first closing quote ends the value
 *   (which may span lines), and double quotes decode \n and \r;
 * - an unquoted value ends at the first `#` (a comment) and is trimmed;
 * - the last assignment of a key in the file wins.
 *
 * `$NAME` / `${NAME}` references stay as written: Bun expands them from the
 * environment the app starts in, which a plan can't see. Bun 1.3 differs in
 * two corners only: it reads a quoted value followed by more text on its line
 * literally, and it doesn't skip a leading byte-order mark.
 */

/** Bun's dotenv whitespace — line breaks included, so a value may start on the next line. */
const WHITESPACE = "\t\v\f \n\r";

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.includes(ch);
}

function isKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9_.-]$/.test(ch);
}

function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text[start])) start++;
  while (end > start && isWhitespace(text[end - 1])) end--;
  return text.slice(start, end);
}

/** A quoted value's content: double quotes decode \n and \r; a CR (or CRLF) inside becomes LF. */
function unquote(inner: string, quote: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i] as string;
    if (ch === "\\" && quote === '"') {
      const next = inner[i + 1] ?? "";
      out += next === "n" ? "\n" : next === "r" ? "\r" : `\\${next}`;
      i += 2;
    } else if (ch === "\r") {
      i += 1;
      if (inner[i] !== "\n") out += "\n";
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

class DotenvReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  /** Every key the text assigns, with the value of its last assignment. */
  read(): Map<string, string> {
    const values = new Map<string, string>();
    while (this.pos < this.src.length) {
      const key = this.key(true);
      if (key === null) this.skipLine();
      else values.set(key, this.value());
    }
    return values;
  }

  private skipLine(): void {
    while (this.pos < this.src.length && !"\n\r".includes(this.src[this.pos] as string)) {
      this.pos++;
    }
    this.pos = Math.min(this.pos + 1, this.src.length);
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.src[this.pos])) this.pos++;
  }

  /** `KEY=` or `KEY: ` (optionally after `export`), leaving the cursor on the value; else null. */
  private key(allowExport: boolean): string | null {
    if (allowExport) this.skipWhitespace();
    const start = this.pos;
    let end = start;
    while (isKeyChar(this.src[end])) end++;
    if (start < end && end < this.src.length) {
      this.pos = end;
      this.skipWhitespace();
      const exported = allowExport && end < this.pos && this.src.slice(start, end) === "export";
      const key = exported ? this.key(false) : null;
      if (key !== null) return key;
      if (this.src[this.pos] === "=") {
        this.pos += 1;
        return this.src.slice(start, end);
      }
      if (this.src[this.pos] === ":" && isWhitespace(this.src[this.pos + 1])) {
        this.pos += 2;
        return this.src.slice(start, end);
      }
    }
    this.pos = start;
    return null;
  }

  private value(): string {
    const start = this.pos;
    this.skipWhitespace();
    if (this.pos >= this.src.length) return "";
    const quote = this.src[this.pos] as string;
    if (quote === '"' || quote === "'" || quote === "`") {
      const quoted = this.quoted(quote);
      if (quoted !== null) return quoted;
    }
    let end = start;
    while (end < this.src.length && !"#\r\n".includes(this.src[end] as string)) end++;
    this.pos = end;
    return trimWhitespace(this.src.slice(start, end));
  }

  /** The value inside the quotes at the cursor (the rest of the closing line is dropped); null when they never close. */
  private quoted(quote: string): string | null {
    for (let end = this.pos + 1; end < this.src.length; end++) {
      if (this.src[end] === "\\") {
        end++;
      } else if (this.src[end] === quote) {
        const inner = this.src.slice(this.pos + 1, end);
        this.pos = end + 1;
        this.skipLine();
        return unquote(inner, quote);
      }
    }
    return null;
  }
}

/** Every key a dotenv text assigns, with the value Bun loads for it (references unexpanded). */
export function dotenvValues(text: string): Map<string, string> {
  return new DotenvReader(text.startsWith("\uFEFF") ? text.slice(1) : text).read();
}
