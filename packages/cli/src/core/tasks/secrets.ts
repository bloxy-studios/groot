/**
 * Secret-looking ADDITIONS in a task's diff. Findings name the location and
 * the kind of secret — never the value — so a review can be shown, stored,
 * and returned to agents safely. Detection covers well-known credential
 * shapes, quoted literals assigned to sensitive names, values in .env-style
 * files, and newly added files that conventionally hold secrets.
 */
import { basename } from "node:path";

const SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "Anthropic API key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{30,}/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SENSITIVE_NAME =
  "[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH_KEY|CREDENTIAL)[A-Za-z0-9_]*";
/** NAME = "literal" / NAME: 'literal' (quoted, ≥ 8 chars). */
const QUOTED_ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_NAME})["']?\\s*[:=]\\s*(["'\`])([^"'\`\\s]{8,})\\2`,
  "i",
);
/** NAME=value in .env-style files (unquoted). */
const ENV_ASSIGNMENT = new RegExp(
  `^\\s*(?:export\\s+)?(${SENSITIVE_NAME})\\s*=\\s*["']?([^"'\\s#]{8,})`,
  "i",
);
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|<.*>|\$\{.*\}|\{\{.*\}\}|changeme|change[-_]?me|example|placeholder|your[-_].*|replace[-_]?me|dummy|redacted|\[redacted\]|todo|none|null|undefined)$/i;

const SECRET_FILES: readonly RegExp[] = [
  /^\.env(?:\.(?!example$|sample$|template$|defaults$)[\w.-]+)?$/,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /^credentials\.json$/,
  /^\.npmrc$/,
  /^\.netrc$/,
];

function isEnvFile(path: string): boolean {
  return /^\.env(?:\.|$)/.test(basename(path));
}

/** Kind of secret on an added line, or null. */
export function secretKind(path: string, line: string): string | null {
  for (const shape of SHAPES) if (shape.pattern.test(line)) return shape.label;
  const quoted = QUOTED_ASSIGNMENT.exec(line);
  if (quoted !== null && !PLACEHOLDER.test(quoted[3] ?? "")) {
    return `literal value assigned to ${quoted[1]}`;
  }
  if (isEnvFile(path)) {
    const env = ENV_ASSIGNMENT.exec(line);
    if (env !== null && !PLACEHOLDER.test(env[2] ?? "")) return `value for ${env[1]}`;
  }
  return null;
}

export function isSecretFile(path: string): boolean {
  const name = basename(path);
  return SECRET_FILES.some((pattern) => pattern.test(name));
}

export interface AddedLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Added lines from `git diff -U0` output (paths unquoted with
 * core.quotePath=false; binary files carry no lines).
 */
export function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let path: string | null = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      path = target === "/dev/null" ? null : target.replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      next = Number(/\+(\d+)/.exec(raw)?.[1] ?? "0");
      continue;
    }
    if (path !== null && raw.startsWith("+")) {
      added.push({ path, line: next, text: raw.slice(1) });
      next++;
    }
  }
  return added;
}

/** "path:line — kind" findings for secret-looking additions (never values). */
export function findSecrets(lines: readonly AddedLine[], addedFiles: readonly string[]): string[] {
  const findings = lines
    .map((entry) => {
      const kind = secretKind(entry.path, entry.text);
      return kind === null ? null : `${entry.path}:${entry.line} — ${kind}`;
    })
    .filter((finding): finding is string => finding !== null);
  const files = addedFiles
    .filter(isSecretFile)
    .map((path) => `${path} — added a file of a kind that usually holds secrets`);
  return [...new Set([...files, ...findings])];
}
