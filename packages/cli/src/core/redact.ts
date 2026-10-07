/**
 * Secret redaction for anything that leaves the execution boundary: command
 * logs, runner transcripts, evidence artifacts, MCP results. Known secret
 * values (e.g. a generated BETTER_AUTH_SECRET) are replaced exactly; common
 * credential shapes and sensitive `NAME=value` assignments are masked by
 * pattern. Redaction is defense in depth — Groot also never prints values it
 * generates.
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
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** NAME=value / NAME: value where NAME looks sensitive. */
const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH_KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;

/** Cookie values (e.g. session tokens in HTTP traces). */
const COOKIE_VALUE = /\b((?:set-)?cookie\s*:\s*[^=;\n]+=)([^;\n]+)/gi;

export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(
    SENSITIVE_ASSIGNMENT,
    (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  );
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
