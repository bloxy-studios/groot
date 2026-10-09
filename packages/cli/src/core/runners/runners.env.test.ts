/**
 * The environment runner children and unreviewed code receive: session,
 * preload, and multiplexer variables scrubbed (provider selectors kept); the
 * values redacted from logs, evidence, and events; and the credential-free
 * environment for pre-review acceptance — every credential shape Groot
 * recognizes removed, what tests need kept.
 */
import { describe, expect, test } from "bun:test";
import { credentialFreeEnv, isScrubbed, knownSecretsFromEnv, runnerEnv } from "./env.ts";

describe("runner child environment", () => {
  test("session, preload, and multiplexer variables are scrubbed; provider selectors are kept", () => {
    // Arrange
    const base = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/x",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_PID: "1",
      CLAUDE_EFFORT: "max",
      NODE_OPTIONS: "--require x",
      CMUX_SURFACE_ID: "abc",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://example",
    };

    // Act
    const claude = runnerEnv(base, "claude-code");
    const codex = runnerEnv(base, "codex", {
      prependPath: ["/vendor/path"],
      extra: { CODEX_MANAGED_BY_BUN: "1" },
    });

    // Assert
    for (const name of Object.keys(base).filter(isScrubbed)) expect(claude[name]).toBeUndefined();
    expect(Object.keys(base).filter(isScrubbed)).toHaveLength(11);
    expect(claude).toMatchObject({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(codex.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    expect(codex.PATH).toBe("/vendor/path:/usr/bin");
    expect(codex.CODEX_MANAGED_BY_BUN).toBe("1");
  });

  test("sensitive variable values become known secrets for log redaction", () => {
    expect(
      knownSecretsFromEnv({
        ANTHROPIC_FOUNDRY_AUTH_TOKEN: "tok-1234567890",
        HOME: "/Users/someone",
        SHORT_TOKEN: "abc",
      }),
    ).toEqual(["tok-1234567890"]);
  });

  test("keys, passes, webhooks, and injected git config values are secrets too; file pointers are not", () => {
    // Arrange
    const secrets = {
      CONVEX_DEPLOY_KEY: "prod:happy-otter-123|eyJ2MiI6IjEyMzQ1Njc4OTAifQ",
      SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-0123456789abcdef",
      JWT_SIGNING_KEY: "jwt-signing-key-0123456789",
      MYSQL_PWD: "hunter2hunter2",
      REDIS_PASS: "redis-pass-123456",
      SMTP_PASS: "smtp-pass-123456",
      GPG_PASSPHRASE: "correct horse battery",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX",
      SENTRY_DSN: "https://0123456789abcdef@o0.ingest.sentry.io/1",
      GITHUB_PAT: "pat-0123456789abcdef",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX3h4eA==",
      CACHE_URL: "redis://default:s3cretpass@cache.internal:6379",
      HOOK_ENDPOINT: "https://example.com/hook?token=abcdef123456",
    };
    const plain = {
      PWD: "/Users/someone/project",
      OLDPWD: "/Users/someone",
      DOCKER_CONFIG: "/Users/someone/.docker",
      KEYBOARD_LAYOUT: "dvorak-programmer",
      GIT_CONFIG_KEY_0: "http.extraheader",
      PUBLIC_URL: "https://example.com/app",
    };

    // Act
    const known = knownSecretsFromEnv({ ...secrets, ...plain });

    // Assert
    expect(known.sort()).toEqual(Object.values(secrets).sort());
  });

  test("the credential-free env (unreviewed code) drops credentials and keeps what tests need", () => {
    // Arrange
    const kept = {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      TMPDIR: "/tmp/x",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      CI: "1",
      BUN_INSTALL: "/Users/someone/.bun",
      USER: "someone",
      TERM: "xterm-256color",
      HTTPS_PROXY: "http://proxy.internal:3128",
      GITHUB_ACTIONS: "true",
      PWD: "/Users/someone/project",
      OLDPWD: "/Users/someone",
      KEYBOARD_LAYOUT: "dvorak-programmer",
      BYPASS_CACHE: "1",
      GIT_CONFIG_GLOBAL: "/Users/someone/.gitconfig",
      INIT_CWD: "/Users/someone/project",
    };
    const dropped = {
      CONVEX_DEPLOY_KEY: "prod:happy-otter-123|eyJ2MiI6IjEyMzQ1Njc4OTAifQ",
      SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-0123456789abcdef",
      JWT_SIGNING_KEY: "jwt-signing-key-0123456789",
      MYSQL_PWD: "hunter2hunter2",
      REDIS_PASS: "redis-pass-123456",
      SMTP_PASS: "smtp-pass-123456",
      GPG_PASSPHRASE: "correct horse battery",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX",
      SENTRY_DSN: "https://0123456789abcdef@o0.ingest.sentry.io/1",
      GITHUB_PAT: "pat-0123456789abcdef",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX3h4eA==",
      GIT_CONFIG_PARAMETERS: "'http.extraheader'='AUTHORIZATION: basic eA=='",
      DOCKER_CONFIG: "/Users/someone/.docker",
      NETRC: "/Users/someone/.netrc",
      NPM_CONFIG_USERCONFIG: "/Users/someone/.npmrc-ci",
      HOOK_ENDPOINT: "https://example.com/hook?token=abcdef123456",
      MY_SERVICE_API_TOKEN: "tok-abcdef1234567890",
      SHORT_TOKEN: "abc",
      GH_TOKEN: "x",
      DB_PASSWORD: "hunter22",
      BUN_CONFIG_TOKEN: "registry-token",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_PROFILE: "prod",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
      AZURE_CLIENT_ID: "client",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      OPENAI_ORG_ID: "org",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CODEX_HOME: "/Users/someone/.codex",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      KUBECONFIG: "/Users/someone/.kube/config",
      DATABASE_URL: "postgres://app:s3cret@db.internal:5432/app",
      CLAUDECODE: "1",
      NODE_OPTIONS: "--require /tmp/preload.js",
    };

    // Act
    const env = credentialFreeEnv({ ...kept, ...dropped });

    // Assert
    expect(env).toEqual(kept);
  });
});
