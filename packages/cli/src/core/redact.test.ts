/**
 * Redaction rules: assignments are matched within one line and only with a
 * real value (not a code reference or template); URL credentials are masked
 * unless they are code; private keys are masked even when output was cut,
 * while a merely mentioned marker leaves its text alone; streamed text is
 * released line by line so a secret split across reads is still caught; and
 * every rule stays linear on long inputs.
 */
import { describe, expect, test } from "bun:test";
import { createLineRedactor, redact } from "./redact.ts";

describe("sensitive assignments", () => {
  test("an empty placeholder does not swallow the next line", () => {
    // Arrange
    const envExample = "BETTER_AUTH_SECRET=\nDATABASE_URL=./data/app.db\nPORT=3001\n";

    // Act
    const out = redact(envExample);

    // Assert
    expect(out).toBe(envExample);
  });

  test("code that references a secret stays intact", () => {
    // Arrange
    const source = [
      "const secret = process.env.BETTER_AUTH_SECRET;",
      "export const tokens = 5;",
      "  secret: process.env.BETTER_AUTH_SECRET,",
      "const apiKey = Bun.env.API_KEY ?? import.meta.env.VITE_API_KEY;",
      "token: import.meta.env.PUBLIC_TOKEN,",
      "let token = await getToken();",
      "  secret: c.env.BETTER_AUTH_SECRET,",
      "  apiKey: env.API_KEY,",
      '  token: process.env["GITHUB_TOKEN"],',
      "  password: string;",
      `AUTH_SECRET=\${SECRET_FROM_VAULT}`,
      `AUTH_SECRET="\${VAULT_SECRET}"`,
      "PASSWORD=$DB_PASSWORD",
    ].join("\n");

    // Act
    const out = redact(source);

    // Assert
    expect(out).toBe(source);
  });

  test("real values are still masked", () => {
    // Arrange
    const log = [
      "password: hunter2",
      "API_KEY=sk-abc",
      'BETTER_AUTH_SECRET="quoted value"',
      "db_password = s3cr3t",
      'const apiKey = "literal-key-value";',
      "SECRETSECRETSECRET_TOKEN=abc123",
      `PASSWORD=\${DB_PASSWORD:-hunter2}`,
    ].join("\n");

    // Act
    const out = redact(log);

    // Assert
    expect(out).toBe(
      [
        "password: [REDACTED]",
        "API_KEY=[REDACTED]",
        "BETTER_AUTH_SECRET=[REDACTED]",
        "db_password = [REDACTED]",
        "const apiKey = [REDACTED];",
        "SECRETSECRETSECRET_TOKEN=[REDACTED]",
        "PASSWORD=[REDACTED]",
      ].join("\n"),
    );
  });
});

describe("credential shapes", () => {
  test("URL credentials are masked, user and host kept", () => {
    // Arrange
    const text = [
      "DATABASE_URL=postgres://app:hunter2@db.internal:5432/app",
      "redis://:p%40ss@cache:6379",
      "see https://example.com/docs and http://localhost:3000/path",
    ].join("\n");

    // Act
    const out = redact(text);

    // Assert
    expect(out).toBe(
      [
        "DATABASE_URL=postgres://app:[REDACTED]@db.internal:5432/app",
        "redis://:[REDACTED]@cache:6379",
        "see https://example.com/docs and http://localhost:3000/path",
      ].join("\n"),
    );
  });

  test("URL credentials that are code or templates stay intact", () => {
    // Arrange: source text, so its `\${…}` are literal characters here.
    const source = [
      `const url = \`postgres://\${user}:\${password}@\${host}/db\`;`,
      `new URL(\`redis://:\${process.env.REDIS_PASSWORD}@localhost:6379\`)`,
      `DATABASE_URL="postgres://app:\${DB_PASSWORD}@db:5432/app"`,
      "DATABASE_URL=postgres://app:$DB_PASSWORD@db/app",
      'dsn = f"postgresql://{user}:{password}@{host}/db"',
      'fmt.Sprintf("postgres://%s:%s@%s/%s", user, pass, host, name)',
      `const remote = \`https://x-access-token:\${token}@github.com/\${repo}.git\`;`,
      "curl http://token:8080/health",
    ].join("\n");

    // Act
    const out = redact(source);

    // Assert
    expect(out).toBe(source);
  });

  test("URL credentials with a literal or default value are still masked", () => {
    // Arrange
    const text = [
      `postgres://app:\${DB_PASSWORD:-hunter2}@db/app`,
      "https://x-access-token:$ecret-value@example.com/repo.git",
    ].join("\n");

    // Act
    const out = redact(text);

    // Assert
    expect(out).toBe(
      [
        "postgres://app:[REDACTED]@db/app",
        "https://x-access-token:[REDACTED]@example.com/repo.git",
      ].join("\n"),
    );
  });

  test("a private key is masked whole, also when cut off at either end", () => {
    // Arrange
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";
    const whole = `before\n${begin}\nMIIEvgIBADANBg\nkqhkiG9w0BAQEF\n${end}\nafter`;
    const cutAtEnd = `before\n${begin}\nMIIEvgIBADANBg\nkqhkiG9w0`;
    const cutAtStart = `kqhkiG9w0BAQEF\n${end}\nafter`;

    // Act
    const outs = [whole, cutAtEnd, cutAtStart].map((text) => redact(text));

    // Assert
    expect(outs).toEqual(["before\n[REDACTED]\nafter", "before\n[REDACTED]", "[REDACTED]\nafter"]);
  });

  test("a cut-off key is masked through its base64 lines, not the text around it", () => {
    // Arrange
    const begin = "-----BEGIN RSA PRIVATE KEY-----";
    const end = "-----END RSA PRIVATE KEY-----";
    const cutAtEnd = `start\n${begin}\nMIIEvgIBADANBgkqhkiG9w0BAQEF\nAASCBKgwggSkAgEAAoIBAQC7\nFAIL src/keys.test.ts\n  1 failed\n`;
    const cutAtStart = `log: loading key\nAASCBKgwggSkAgEAAoIBAQC7\nkqhkiG9w0BAQEF\n${end}\nnext step`;

    // Act
    const outs = [cutAtEnd, cutAtStart].map((text) => redact(text));

    // Assert
    expect(outs).toEqual([
      "start\n[REDACTED]\nFAIL src/keys.test.ts\n  1 failed\n",
      "log: loading key\n[REDACTED]\nnext step",
    ]);
  });

  test("a cut-off key inside a JSON string is masked and the line stays valid JSON", () => {
    // Arrange: transcript lines carry keys with escaped line breaks.
    const head = JSON.stringify({
      type: "tool_result",
      content: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEF\nAASCBKgwggSk",
    });
    const tail = JSON.stringify({
      type: "tool_result",
      content: "AASCBKgwggSkAgEAAoIBAQC7\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----\n",
    });

    // Act
    const outs = [head, tail].map((line) => JSON.parse(redact(line)));

    // Assert
    expect(outs).toEqual([
      { type: "tool_result", content: "[REDACTED]" },
      { type: "tool_result", content: "[REDACTED]\n" },
    ]);
  });

  test("a lone BEGIN or END marker leaves the text around it intact", () => {
    // Arrange: text that only mentions the markers.
    const texts = [
      '{"type":"assistant","message":{"content":"The key file must start with -----BEGIN PRIVATE KEY----- and end with the END line."}}',
      "test a ... ok\nexpected header -----BEGIN RSA PRIVATE KEY-----\nFAIL src/keys.test.ts > parses PEM\n  12 passed, 1 failed\n",
      "line1\nline2\nparser: missing -----END PRIVATE KEY----- footer\ntail",
    ];

    // Act
    const outs = texts.map((text) => redact(text));

    // Assert
    expect(outs).toEqual(texts);
  });
});

describe("streamed output", () => {
  test("a known secret split across reads is matched whole", () => {
    // Arrange
    const secret = "abcdef1234567890";
    const stream = createLineRedactor([secret]);

    // Act
    const out = [stream.push("value abcdef12"), stream.push("34567890\nnext"), stream.flush()];

    // Assert
    expect(out).toEqual(["", "value [REDACTED]\n", "next"]);
  });

  test("an assignment split across reads is matched whole", () => {
    // Arrange
    const stream = createLineRedactor();

    // Act
    const out =
      stream.push("BETTER_AUTH_SECRET=") + stream.push("hunter2hunter2\n") + stream.flush();

    // Assert
    expect(out).toBe("BETTER_AUTH_SECRET=[REDACTED]\n");
  });

  test("a private key spread over many reads is held back until its END line", () => {
    // Arrange
    const stream = createLineRedactor();
    const reads = [
      "start\n-----BEGIN RSA PRIVATE KEY-----\n",
      "MIIEvgIBADANBg\n",
      "kqhkiG9w0BAQEF\n",
      "-----END RSA PRIVATE KEY-----\nend\n",
    ];

    // Act
    const out = reads.map((read) => stream.push(read));

    // Assert
    expect(out).toEqual(["start\n", "", "", "[REDACTED]\nend\n"]);
    expect(stream.flush()).toBe("");
  });

  test("a line that only mentions a BEGIN marker is not held back", () => {
    // Arrange
    const stream = createLineRedactor();

    // Act
    const out = [
      stream.push("expected -----BEGIN PRIVATE KEY----- here\n"),
      stream.push("-----BEGIN PRIVATE KEY-----\n"),
      stream.push("not a key line\n"),
    ];

    // Assert
    expect(out).toEqual([
      "expected -----BEGIN PRIVATE KEY----- here\n",
      "",
      "-----BEGIN PRIVATE KEY-----\nnot a key line\n",
    ]);
    expect(stream.flush()).toBe("");
  });
});

describe("cost", () => {
  test("stays linear on long runs where many matches could start", () => {
    // Arrange: inputs that made earlier patterns quadratic (tens of seconds and up).
    const inputs = [
      "a-".repeat(150_000),
      "a.".repeat(150_000),
      "-----BEGIN PRIVATE KEY-----\n".repeat(10_000),
    ];

    // Act
    const started = performance.now();
    for (const text of inputs) redact(text, ["known-secret-value"]);
    const elapsedMs = performance.now() - started;

    // Assert: linear work takes milliseconds; the bound only leaves room for a loaded machine.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  test("stays linear on long words, cookies, tokens, and key lines", () => {
    // Arrange: each input took minutes or more at this size while a pattern was quadratic.
    const keyLines = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n";
    const inputs = [
      "SECRET".repeat(50_000),
      "aTOKEN_".repeat(45_000),
      "cookie: x ".repeat(30_000),
      "cookie:".repeat(45_000),
      "set-cookie:a".repeat(25_000),
      "eyJ".repeat(100_000),
      `TOKEN=${"a.".repeat(150_000)}`,
      `${keyLines.repeat(6_000)}-----END PRIVATE KEY-----\n`,
      `-----BEGIN PRIVATE KEY-----\n${keyLines.repeat(6_000)}`,
      `${keyLines}-----END PRIVATE KEY-----\n`.repeat(5_000),
      `-----BEGIN PRIVATE KEY-----\n${keyLines}`.repeat(5_000),
      `-----BEGIN PRIVATE KEY-----${"\\".repeat(200_000)}`,
      `${"\\".repeat(200_000)}-----END PRIVATE KEY-----`,
      `-----BEGIN RSA PRIVATE KEY-----${"\nProc-Type: 4,ENCRYPTED".repeat(20_000)}`,
    ];

    // Act
    const started = performance.now();
    for (const text of inputs) redact(text, ["known-secret-value"]);
    const elapsedMs = performance.now() - started;

    // Assert: linear work takes milliseconds; the bound only leaves room for a loaded machine.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  test("the line redactor stays linear while a long key-like block streams in", () => {
    // Arrange: a BEGIN line followed by a megabyte of base64 lines, read line by line.
    const stream = createLineRedactor();
    const keyLine = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n";

    // Act
    const started = performance.now();
    let out = stream.push("-----BEGIN PRIVATE KEY-----\n");
    for (let read = 0; read < 20_000; read += 1) out += stream.push(keyLine);
    out += stream.flush();
    const elapsedMs = performance.now() - started;

    // Assert: the BEGIN line and the base64 lines held with it are masked, in linear time.
    expect(out.startsWith("[REDACTED]\n")).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);
});
