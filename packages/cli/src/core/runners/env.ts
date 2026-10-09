/**
 * Child environment for runner processes. Groot itself often runs inside a
 * Claude Code session (or a terminal multiplexer that wraps agents); those
 * inherited variables would mark the child as a nested session, raise its
 * effort, inject Node preload modules, or re-activate wrapper shims. They are
 * removed. Provider selectors (CLAUDE_CODE_USE_FOUNDRY, ANTHROPIC_*, OPENAI_*)
 * are kept — Groot reuses each tool's own login and never reads credentials.
 *
 * Code nobody has reviewed yet (the agent's change under pre-review acceptance
 * checks) gets `credentialFreeEnv` instead: no credentials at all.
 */
import type { RunnerId } from "../contracts/task.ts";

/** Exact names scrubbed from every runner child. */
export const SCRUBBED_ENV: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "NODE_OPTIONS",
];

/** Name prefixes scrubbed from every runner child. */
export const SCRUBBED_ENV_PREFIXES: readonly string[] = ["CLAUDE_CODE_MESSAGING_", "CMUX_"];

export function isScrubbed(name: string): boolean {
  return (
    SCRUBBED_ENV.includes(name) || SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Set for Claude runs: bounded runs never background work or self-update mid-task. */
const CLAUDE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  DISABLE_AUTOUPDATER: "1",
};

export interface RunnerEnvOptions {
  /** Directories to prepend to PATH (Codex's bundled tools when spawning its native binary). */
  readonly prependPath?: readonly string[];
  /** Extra variables the launcher would have set (e.g. CODEX_MANAGED_BY_BUN). */
  readonly extra?: Readonly<Record<string, string>>;
}

/** The scrubbed environment a runner child receives. */
export function runnerEnv(
  base: Readonly<Record<string, string | undefined>>,
  runner: RunnerId,
  options: RunnerEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isScrubbed(name)) continue;
    env[name] = value;
  }
  const prepend = options.prependPath ?? [];
  if (prepend.length > 0) {
    env.PATH = [...prepend, ...(env.PATH ?? "").split(":").filter(Boolean)].join(":");
  }
  return {
    ...env,
    ...(options.extra ?? {}),
    ...(runner === "claude-code" ? CLAUDE_ENV : {}),
  };
}

/** Name fragments that mark a credential anywhere in a variable name. */
const SENSITIVE_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|AUTH|CREDENTIAL|PRIVATE|WEBHOOK)/i;
/** Whole `_`-separated words that mark a credential (CONVEX_DEPLOY_KEY, MYSQL_PWD, SMTP_PASS). */
const SENSITIVE_WORD = /(?:^|_)(?:KEYS?|PASS|PWD|PAT|DSN)(?:_|$)/i;
/** Named like a credential, but the working directory. */
const NOT_SENSITIVE: ReadonlySet<string> = new Set(["PWD", "OLDPWD"]);
/** Git config injected through the environment (`http.extraheader` can carry an Authorization header). */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;
const GIT_CONFIG_VALUES = /^GIT_CONFIG_(?:VALUE_\d+|PARAMETERS)$/;

/** A URL carrying a password (`scheme://user:pass@host`), e.g. DATABASE_URL. */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i;
/** A URL carrying a credential in its query (`?token=…`, `&key=…`, `&sig=…`). */
const URL_WITH_SECRET_QUERY =
  /[a-z][a-z0-9+.-]*:\/\/\S*[?&](?:access_?token|token|api_?key|key|secret|sig|signature|password|auth)=[^&\s]+/i;

function isSensitiveName(name: string): boolean {
  if (NOT_SENSITIVE.has(name.toUpperCase())) return false;
  if (GIT_CONFIG_ENV.test(name)) return GIT_CONFIG_VALUES.test(name);
  return SENSITIVE_NAME.test(name) || SENSITIVE_WORD.test(name);
}

function isSecretValue(value: string): boolean {
  return URL_WITH_PASSWORD.test(value) || URL_WITH_SECRET_QUERY.test(value);
}

/**
 * Values of sensitive-looking variables (by name, or URLs that carry a
 * password or token), redacted exactly from runner logs, evidence, and
 * events — an agent that echoes its environment must not leak a provider
 * token into `.groot/tasks/<id>/attempt-<n>.jsonl`.
 */
export function knownSecretsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== undefined && value.length >= 8 && (isSensitiveName(name) || isSecretValue(value)),
    )
    .map(([, value]) => value as string);
}

/** Cloud, model-provider, agent, and package-registry namespaces: credentials and account selection. */
const CREDENTIAL_PREFIXES: readonly string[] = [
  "AWS_",
  "AZURE_",
  "ARM_",
  "GOOGLE_",
  "GCLOUD_",
  "GCP_",
  "CLOUDSDK_",
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_CODE_",
  "CODEX_",
  "NPM_CONFIG_",
];

/** Access to keys or credential files without a secret-looking name. */
const CREDENTIAL_NAMES: readonly string[] = [
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "KUBECONFIG",
  "DOCKER_CONFIG",
  "NETRC",
  "GNUPGHOME",
  "GH_CONFIG_DIR",
];

function isCredential(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  return (
    isSensitiveName(name) ||
    GIT_CONFIG_ENV.test(name) ||
    CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    CREDENTIAL_NAMES.includes(upper) ||
    isSecretValue(value)
  );
}

/**
 * The environment for code nobody has reviewed yet (pre-review acceptance
 * checks run what the agent wrote): credential-looking variables are removed
 * — sensitive names (TOKEN, SECRET, PASSWORD, API_KEY, AUTH, … anywhere in
 * the name; KEY, PASS, PWD, PAT, DSN as whole words), cloud/provider/agent/
 * registry namespaces, git config injected through the environment,
 * key-agent sockets and credential-file pointers, URLs carrying a password
 * or token — and so are the agent-session variables. What tests need (PATH,
 * HOME, TMPDIR, LANG/LC_*, CI, BUN_*, proxies without credentials) stays.
 * Name patterns cannot recognize every credential, and files under HOME stay
 * readable: this is not a sandbox.
 */
export function credentialFreeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isScrubbed(name) || isCredential(name, value)) continue;
    out[name] = value;
  }
  return out;
}
