/**
 * Secret redaction for anything that leaves the execution boundary: command
 * logs, runner transcripts, evidence artifacts, MCP results. Known secret
 * values (e.g. a generated BETTER_AUTH_SECRET) are replaced exactly; common
 * credential shapes, private keys, URL credentials, and sensitive
 * `NAME=value` assignments are masked by pattern. Code and templates are left
 * alone (environment references, `${…}` interpolations), and text that only
 * mentions a key marker keeps what surrounds it. Redaction is defense in
 * depth — Groot also never prints values it generates.
 *
 * Every rule runs in time linear in its input: whole captures (megabytes) and
 * every MCP result are redacted, so no input may stall a command.
 */

const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // A JWT is matched from the start of its run only, so long runs of "eyJ" stay linear.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * scheme://user:password@host — the password is masked, user and host are
 * kept. The scheme length is bounded so long dotted/hyphenated runs stay linear.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]*:)([^\s/]+)(?=@)/gi;

/**
 * A value that is code or a template, not a secret: an interpolation
 * (`${password}`, `{password}`, `{{.Password}}`), an environment variable
 * (`$DB_PASSWORD`), or a format verb (`%s`). A shell default
 * (`${DB_PASSWORD:-value}`) carries a value and is masked.
 */
const PLACEHOLDER =
  /^(?:\$?\{\{?(?!\w+:?[-=?+])[^{}\s]*\}\}?|\$[A-Z_][A-Z0-9_]*|%(?:\([\w.]*\))?[sdvq])$/;

/**
 * Text right before a name that sits in a URL's authority
 * (`https://x-access-token:…@host`, `http://token:8080`): the URL rule owns it.
 */
const IN_URL_AUTHORITY = /:\/\/[^\s:@/]*$/;

/** Name fragments that make an assignment sensitive. */
const SENSITIVE_NAME = "SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH_KEY|CREDENTIAL";

/**
 * NAME=value / NAME: value where NAME looks sensitive — within one line, with
 * a non-empty value. The name is captured inside lookaheads, which never
 * backtrack, so one long word full of name fragments stays linear.
 */
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`\b(?=[A-Za-z0-9_]*?(?:${SENSITIVE_NAME}))(?=([A-Za-z0-9_]+))\1([ \t]*[=:][ \t]*)("[^"\n]+"|'[^'\n]+'|[^\s"',;]+)`,
  "gi",
);

/**
 * Values that are code, not secrets: environment references (`process.env.X`,
 * `Bun.env.X`, `import.meta.env.X`, `c.env.X`, `env.X`, `process.env["X"]`)
 * and keyword or type literals.
 */
const NOT_A_SECRET =
  /^(?:(?:[\w$]+\.)*(?:env|environ)[.[]|(?:true|false|null|undefined|string|number|boolean)$)/i;

/** A JS declaration keyword right before the name: an unquoted value there is an expression. */
const DECLARED = /(?:^|[^\w$])(?:const|let|var)[ \t]+$/;

/** How far back the name's context is inspected (declarations, URL authorities). */
const NAME_CONTEXT_CHARS = 64;

/**
 * Cookie values (e.g. session tokens in HTTP traces). A cookie name has no
 * whitespace, `:`, `;`, or `=`.
 */
const COOKIE_VALUE = /\b((?:set-)?cookie[ \t]*:[ \t]*[^=;:\s]*=)([^;\n]+)/gi;

/** BEGIN and END lines of a PEM private key (any key type). */
const KEY_MARKER = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;

/**
 * A line break inside key text: a real one, or one escaped inside a string
 * (JSON's `\n`). An escape is matched from the first backslash of its run
 * only, so long runs of backslashes stay linear.
 */
const BREAK = String.raw`(?:\r?\n|(?<!\\)\\+r\\+n|(?<!\\)\\+n)`;

const KEY_LINE_BREAK = new RegExp(BREAK, "g");

/** One line of key material: base64, optionally indented. */
const KEY_LINE = /^[ \t]*[A-Za-z0-9+/=]+[ \t]*$/;

const BLANK = /^[ \t]*$/;

/** Characters key lines, their indentation, and their (escaped) breaks consist of. */
const KEY_TEXT = /[A-Za-z0-9+/= \t\r\n\\]/;

/** The headers of an encrypted PEM key, through the start of the blank line after them. */
const KEY_HEADERS = new RegExp(
  String.raw`(?:${BREAK}[ \t]*(?:Proc-Type|DEK-Info):[^\r\n\\]*)+${BREAK}[ \t]*(?=${BREAK})`,
  "y",
);

/** What may follow a BEGIN marker while its key is still arriving: headers and key lines. */
const KEY_SO_FAR = new RegExp(
  String.raw`^[ \t]*(?:(?:${BREAK}[ \t]*(?:Proc-Type|DEK-Info):[^\r\n\\]*)+${BREAK}[ \t]*)?(?:${BREAK}[ \t]*[A-Za-z0-9+/=]+[ \t]*)*(?:\r?\n)?$`,
);

/** String delimiters: a cut-off key inside a JSON or JS string ends (or starts) at one. */
const QUOTES: ReadonlySet<string> = new Set(['"', "'", "`"]);

interface Span {
  readonly start: number;
  readonly end: number;
}

/** The lines of text[from, to), split at real and escaped line breaks. */
function linesOf(text: string, from: number, to: number): Span[] {
  const lines: Span[] = [];
  let start = from;
  for (const lineBreak of text.slice(from, to).matchAll(KEY_LINE_BREAK)) {
    lines.push({ start, end: from + lineBreak.index });
    start = from + lineBreak.index + lineBreak[0].length;
  }
  lines.push({ start, end: to });
  return lines;
}

const lineMatches = (pattern: RegExp, text: string, line: Span | undefined): boolean =>
  line !== undefined && pattern.test(text.slice(line.start, line.end));

/**
 * End of the key lines after a BEGIN marker that ends at `from` (its block was
 * cut off before the END), or `from` when no key line follows — the text only
 * mentions the marker.
 */
function keyLinesAfter(text: string, from: number): number {
  KEY_HEADERS.lastIndex = from;
  const start = KEY_HEADERS.test(text) ? KEY_HEADERS.lastIndex : from;
  let to = start;
  while (to < text.length && KEY_TEXT.test(text.charAt(to))) to += 1;
  const lines = linesOf(text, start, to);
  if (!lineMatches(BLANK, text, lines[0])) return from; // key lines start on the next line
  let end = from;
  for (let index = 1; index < lines.length; index += 1) {
    // A last line cut short by other text is whole only at the end of the text or of a string.
    const cutShort = index === lines.length - 1 && to < text.length && !QUOTES.has(text.charAt(to));
    if (cutShort || !lineMatches(KEY_LINE, text, lines[index])) break;
    end = (lines[index] as Span).end;
  }
  return end;
}

/**
 * Start of the key lines before an END marker that starts at `to` (its block
 * was cut off before the BEGIN), or `to` when no key line precedes it.
 */
function keyLinesBefore(text: string, to: number): number {
  let from = to;
  while (from > 0 && KEY_TEXT.test(text.charAt(from - 1))) from -= 1;
  const lines = linesOf(text, from, to);
  if (!lineMatches(BLANK, text, lines[lines.length - 1])) return to; // the marker starts its line
  let start = to;
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    // A first line cut short by other text is whole only at the start of the text or of a string.
    const cutShort = index === 0 && from > 0 && !QUOTES.has(text.charAt(from - 1));
    if (cutShort || !lineMatches(KEY_LINE, text, lines[index])) break;
    start = (lines[index] as Span).start;
  }
  return start;
}

/**
 * Private keys: a complete block is masked whole (a BEGIN through the nearest
 * END). A block cut off at either end of the text is masked through its
 * base64 lines only, so a marker that is merely mentioned leaves the text
 * around it intact.
 */
function maskPrivateKeys(text: string): string {
  const spans: Span[] = [];
  let begins: Span[] = []; // BEGIN markers since the last END
  for (const marker of text.matchAll(KEY_MARKER)) {
    const start = marker.index;
    const end = start + marker[0].length;
    if (marker[1] === "BEGIN") {
      begins.push({ start, end });
      continue;
    }
    const first = begins[0];
    begins = [];
    const keyStart = first?.start ?? keyLinesBefore(text, start);
    if (keyStart < start) spans.push({ start: keyStart, end });
  }
  for (const begin of begins) {
    const keyEnd = keyLinesAfter(text, begin.end);
    if (keyEnd > begin.end) spans.push({ start: begin.start, end: keyEnd });
  }
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += `${text.slice(last, span.start)}${REDACTED}`;
    last = span.end;
  }
  return out + text.slice(last);
}

function maskUrlPassword(match: string, prefix: string, password: string): string {
  return PLACEHOLDER.test(password) ? match : `${prefix}${REDACTED}`;
}

function maskAssignment(
  match: string,
  name: string,
  separator: string,
  value: string,
  offset: number,
  text: string,
): string {
  const quoted = value.startsWith('"') || value.startsWith("'");
  const unquoted = quoted ? value.slice(1, -1) : value;
  if (NOT_A_SECRET.test(value) || PLACEHOLDER.test(unquoted)) return match;
  const before = text.slice(Math.max(0, offset - NAME_CONTEXT_CHARS), offset);
  if (IN_URL_AUTHORITY.test(before)) return match;
  if (!quoted && DECLARED.test(before)) return match;
  return `${name}${separator}${REDACTED}`;
}

export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  out = maskPrivateKeys(out);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_CREDENTIALS, maskUrlPassword);
  out = out.replace(SENSITIVE_ASSIGNMENT, maskAssignment);
  out = out.replace(COOKIE_VALUE, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

/** Deep-redact string leaves of a JSON value. */
export function redactValue<T>(value: T, knownSecrets: readonly string[] = []): T {
  if (typeof value === "string") return redact(value, knownSecrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item, knownSecrets),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Longest private key block held back while it streams in. Real keys are a
 * few kilobytes; a longer block is released and redacted as cut off, so a
 * stream of base64 lines after a BEGIN line cannot make every read rescan it.
 */
const MAX_HELD_KEY_BLOCK = 64 * 1024;

/** Redaction for text that arrives in pieces (a child's output, read by read). */
export interface LineRedactor {
  /** Add a piece; returns the redacted complete lines it releases ("" when none). */
  push(chunk: string): string;
  /** End of stream: the redacted remainder. */
  flush(): string;
}

/**
 * Start of the line opening a private key that may still be arriving — the
 * last BEGIN marker, with no END after it and only headers and key lines after
 * it so far — or -1. A mention, or a key already cut short, is not held.
 */
function openKeyBlockStart(text: string): number {
  let begin = -1;
  let afterBegin = 0;
  for (const marker of text.matchAll(KEY_MARKER)) {
    begin = marker[1] === "BEGIN" ? marker.index : -1;
    afterBegin = marker.index + marker[0].length;
  }
  if (begin === -1 || !KEY_SO_FAR.test(text.slice(afterBegin))) return -1;
  return text.lastIndexOf("\n", begin) + 1;
}

/**
 * Release streamed text one complete line at a time — the partial last line
 * (and a private key still arriving) is held back until it is complete — so a
 * secret split across reads is still matched whole. A held-back remainder
 * longer than `maxPending` is released as is, bounding memory.
 */
export function createLineRedactor(
  knownSecrets: readonly string[] = [],
  maxPending = 1_000_000,
): LineRedactor {
  let pending = "";
  const release = (end: number): string => {
    const ready = pending.slice(0, end);
    pending = pending.slice(end);
    return ready === "" ? "" : redact(ready, knownSecrets);
  };
  return {
    push(chunk: string): string {
      pending += chunk;
      const newline = chunk.lastIndexOf("\n");
      if (newline === -1) return pending.length > maxPending ? release(pending.length) : "";
      const complete = pending.length - chunk.length + newline + 1;
      const open = openKeyBlockStart(pending.slice(0, complete));
      const holding = open !== -1 && complete - open <= MAX_HELD_KEY_BLOCK;
      const end = holding ? open : complete;
      return release(end === 0 && pending.length > maxPending ? pending.length : end);
    },
    flush: (): string => release(pending.length),
  };
}
