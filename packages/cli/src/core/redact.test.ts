/**
 * Redaction rules: assignments are matched within one line and only with a
 * real value (not a code reference); URL credentials and private keys are
 * masked even when output was cut; streamed text is released line by line so
 * a secret split across reads is still caught.
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
});
