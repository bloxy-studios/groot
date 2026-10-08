/**
 * Secret redaction for anything that leaves the execution boundary: command
 * logs, runner transcripts, evidence artifacts, MCP results. Known secret
 * values (e.g. a generated BETTER_AUTH_SECRET) are replaced exactly; common
 * credential shapes, URL credentials, and sensitive `NAME=value` assignments
 * are masked by pattern. Redaction is defense in depth — Groot also never
 * prints values it generates.
 */

const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A private key block — also one cut off at the end of the text (output truncated mid-key).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // The tail of a key block whose BEGIN line was cut off (output truncated at the head).
  /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
];

/**
 * scheme://user:password@host — the password is masked, user and host are
 * kept. The scheme length is bounded so long dotted/hyphenated runs stay linear.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]*:)[^\s/]+(?=@)/gi;

/** NAME=value / NAME: value where NAME looks sensitive — within one line, with a non-empty value. */
const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH_KEY|CREDENTIAL)[A-Za-z0-9_]*)([ \t]*[=:][ \t]*)("[^"\n]+"|'[^'\n]+'|[^\s"',;]+)/gi;

/**
 * Values that are code, not secrets: environment references (`process.env.X`,
 * `Bun.env.X`, `import.meta.env.X`, `c.env.X`, `env.X`, `process.env["X"]`)
 * and keyword or type literals.
 */
const NOT_A_SECRET =
  /^(?:(?:[\w$]+\.)*(?:env|environ)[.[]|(?:true|false|null|undefined|string|number|boolean)$)/i;

/** A JS declaration keyword right before the name: an unquoted value there is an expression. */
const DECLARED = /(?:^|[^\w$])(?:const|let|var)[ \t]+$/;

/** Cookie values (e.g. session tokens in HTTP traces). */
const COOKIE_VALUE = /\b((?:set-)?cookie[ \t]*:[ \t]*[^=;\n]+=)([^;\n]+)/gi;

function maskAssignment(
  match: string,
  name: string,
  separator: string,
  value: string,
  offset: number,
  text: string,
): string {
  if (NOT_A_SECRET.test(value)) return match;
  const quoted = value.startsWith('"') || value.startsWith("'");
  if (!quoted && DECLARED.test(text.slice(Math.max(0, offset - 24), offset))) return match;
  return `${name}${separator}${REDACTED}`;
}

export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_CREDENTIALS, (_m, prefix: string) => `${prefix}${REDACTED}`);
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

/** Redaction for text that arrives in pieces (a child's output, read by read). */
export interface LineRedactor {
  /** Add a piece; returns the redacted complete lines it releases ("" when none). */
  push(chunk: string): string;
  /** End of stream: the redacted remainder. */
  flush(): string;
}

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Start of the line opening a private key block that has no END yet, or -1. */
function openKeyBlockStart(text: string): number {
  let lastBegin = -1;
  for (const match of text.matchAll(KEY_BEGIN)) lastBegin = match.index;
  if (lastBegin === -1 || KEY_END.test(text.slice(lastBegin))) return -1;
  return text.lastIndexOf("\n", lastBegin) + 1;
}

/**
 * Release streamed text one complete line at a time — the partial last line
 * (and an open private key block) is held back until it is complete — so a
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
      const complete = pending.lastIndexOf("\n") + 1;
      const open = openKeyBlockStart(pending.slice(0, complete));
      const end = open === -1 ? complete : open;
      return release(end === 0 && pending.length > maxPending ? pending.length : end);
    },
    flush: (): string => release(pending.length),
  };
}
