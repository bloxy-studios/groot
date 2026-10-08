/**
 * Verification engine: per-profile summaries, truthful skipped/blocked
 * outcomes, evidence persistence with redaction, and the server harness's
 * process-group teardown.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationContract } from "../contracts/common.ts";
import { Evidence, VerificationReport } from "../contracts/evidence.ts";
import { ephemeralPort } from "../ports.ts";
import { redactValue } from "../redact.ts";
import { createContext } from "../runtime.ts";
import { appFixture, blueprintFixture } from "../test-fixtures.ts";
import { defaultContracts, registerBuiltInCheckers } from "./checkers.ts";
import { registerChecker, runVerification } from "./engine.ts";
import { startServer } from "./server.ts";
import { listEvidence, readEvidence } from "./store.ts";

registerBuiltInCheckers();

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "groot-verify-"));
  mkdirSync(join(root, "apps/api"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(
    join(root, "apps/api/package.json"),
    JSON.stringify({ name: "api", scripts: { typecheck: "true" } }),
  );
  return root;
}

const ctx = () => createContext({ cwd: tmpdir() });

describe("verification engine", () => {
  test("structural + build profiles: pass, skipped (nothing to run), separate summaries", async () => {
    const root = project();
    const blueprint = blueprintFixture({ apps: [appFixture({ id: "api", path: "apps/api" })] });
    const report = await runVerification(ctx(), {
      root,
      blueprint,
      observation: null,
      lock: null,
      profiles: ["structural", "build"],
      extra: defaultContracts(blueprint),
    });
    expect(report.profiles.structural.status).toBe("pass");
    expect(report.profiles.build).toMatchObject({ status: "pass", pass: 1, skipped: 1 });
    expect(report.profiles.runtime.status).toBe("not-run");
    expect(report.profiles["product-flow"].status).toBe("not-run");
    const skipped = report.evidence.find((entry) => entry.check === "build.script.api");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toContain("no build script");
    for (const entry of report.evidence) expect(Evidence.safeParse(entry).success).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("a missing required secret is blocked with the exact next step, never a pass", async () => {
    const root = project();
    const blueprint = blueprintFixture({
      environment: [
        {
          name: "BETTER_AUTH_SECRET",
          consumer: "apps/api",
          scope: "server",
          sensitivity: "secret",
          required: true,
          description: "signs sessions",
          storage: "apps/api/.env.local",
          example: "",
          generate: "random-secret",
          declaredBy: "auth.better-auth",
        },
      ],
    });
    const report = await runVerification(ctx(), {
      root,
      blueprint,
      observation: null,
      lock: null,
      profiles: ["structural"],
      extra: defaultContracts(blueprint),
    });
    const env = report.evidence.find((entry) => entry.check === "structural.env");
    expect(env?.status).toBe("blocked");
    expect(env?.nextStep).toContain("BETTER_AUTH_SECRET");
    expect(report.profiles.structural.status).toBe("blocked");
    expect(report.ok).toBe(true); // nothing failed; blocked is reported separately
  });

  test("unknown checkers and missing toolchains are blocked; artifacts are redacted and addressable", async () => {
    const root = project();
    const secret = "very-secret-value-123";
    registerChecker("test.leaky", async () => ({
      status: "pass",
      summary: "ok",
      method: { kind: "static", tool: "test.leaky", command: null },
      artifacts: [{ name: "out.log", kind: "log", content: `token=${secret}\nAPI_KEY=abc123456` }],
      secrets: [secret],
    }));
    const contract = (id: string, checker: string, toolchains: string[] = []) => ({
      id,
      profile: "runtime" as const,
      description: id,
      checker,
      capability: null,
      unit: null,
      needs: { network: false, processes: false, credentials: [], toolchains },
    });
    const report = await runVerification(ctx(), {
      root,
      blueprint: blueprintFixture({
        verification: [
          contract("a.unknown", "nope.missing"),
          contract("b.tool", "test.leaky", ["definitely-not-a-real-tool-xyz"]),
          contract("c.leaky", "test.leaky"),
        ],
      }),
      observation: null,
      lock: null,
      profiles: ["runtime"],
    });
    expect(report.evidence.map((entry) => entry.status)).toEqual(["blocked", "blocked", "pass"]);
    const leaky = await readEvidence(root, report.evidence[2]?.id as string);
    const artifact = readFileSync(join(root, leaky.artifacts[0]?.path as string), "utf8");
    expect(artifact).not.toContain(secret);
    expect(artifact).toContain("API_KEY=[REDACTED]");
    expect((await listEvidence(root)).length).toBe(3);
  });

  test("missing credentials block a check by name — the checker never runs, no value is read", async () => {
    const root = project();
    let runs = 0;
    registerChecker("test.credentialed", async () => {
      runs++;
      return { status: "pass", summary: "ok", method: STATIC_METHOD };
    });
    const blueprint = blueprintFixture({
      verification: [
        contract("c.provider", "test.credentialed", "runtime", {
          credentials: ["GROOT_TEST_PROVIDER_TOKEN", "GROOT_TEST_STORED_KEY"],
        }),
      ],
      environment: [
        {
          name: "GROOT_TEST_STORED_KEY",
          consumer: "apps/api",
          scope: "server",
          sensitivity: "secret",
          required: true,
          description: "provider key",
          storage: "apps/api/.env.local",
          example: "",
          generate: "none",
          declaredBy: "test",
        },
      ],
    });
    const run = (env: Record<string, string>) =>
      runVerification(createContext({ cwd: tmpdir(), env }), {
        root,
        blueprint,
        observation: null,
        lock: null,
        profiles: ["runtime"],
      });

    const missing = await run({});
    expect(runs).toBe(0);
    expect(missing.evidence[0]).toMatchObject({
      status: "blocked",
      reason: "credentials not set: GROOT_TEST_PROVIDER_TOKEN, GROOT_TEST_STORED_KEY",
    });
    expect(missing.evidence[0]?.nextStep).toContain("GROOT_TEST_STORED_KEY in apps/api/.env.local");
    expect(missing.profiles.runtime.status).toBe("blocked");

    // One in the process environment, the other assigned (by name) in its declared storage file.
    const value = "stored-value-groot-never-reads";
    writeFileSync(join(root, "apps/api/.env.local"), `GROOT_TEST_STORED_KEY=${value}\n`);
    const present = await run({ GROOT_TEST_PROVIDER_TOKEN: "set" });
    expect(present.evidence[0]?.status).toBe("pass");
    expect(runs).toBe(1);
    expect(JSON.stringify([missing, present])).not.toContain(value);
  });

  test("a missing-credential record still names every credential after redaction", async () => {
    // Arrange — stored evidence and MCP results are redacted, and these names
    // look sensitive (…_API_KEY, …_TOKEN): only a `NAME: value` shape is masked.
    const root = project();
    registerChecker("test.credential-names", async () => ({
      status: "pass",
      summary: "ok",
      method: STATIC_METHOD,
    }));
    const blueprint = blueprintFixture({
      verification: [
        contract("c.names", "test.credential-names", "runtime", {
          credentials: ["PROVIDER_API_KEY", "PROVIDER_TOKEN"],
        }),
      ],
    });
    const run = (env: Record<string, string>) =>
      runVerification(createContext({ cwd: tmpdir(), env }), {
        root,
        blueprint,
        observation: null,
        lock: null,
        profiles: ["runtime"],
      });

    // Act
    const both = (await run({})).evidence[0];
    const one = (await run({ PROVIDER_TOKEN: "set" })).evidence[0];

    // Assert
    for (const entry of [both, one]) {
      const naming = {
        summary: entry?.summary,
        reason: entry?.reason,
        nextStep: entry?.nextStep,
        details: entry?.details,
      };
      expect(redactValue(naming)).toEqual(naming);
    }
    expect(both?.reason).toBe("credentials not set: PROVIDER_API_KEY, PROVIDER_TOKEN");
    expect(one?.reason).toBe("credential not set: PROVIDER_API_KEY");
  });

  test("a cancelled run is interrupted and not ok; a profile with unrun checks never reads as pass", async () => {
    const root = project();
    const controller = new AbortController();
    registerChecker("test.then-cancel", async () => {
      controller.abort("SIGINT");
      return { status: "pass", summary: "ok", method: STATIC_METHOD };
    });
    registerChecker("test.would-fail", async () => ({
      status: "fail",
      summary: "broken",
      method: STATIC_METHOD,
    }));

    const report = await runVerification(
      createContext({ cwd: tmpdir(), signal: controller.signal }),
      {
        root,
        blueprint: blueprintFixture({
          verification: [
            contract("a.first", "test.then-cancel", "build"),
            contract("b.second", "test.would-fail", "build"),
          ],
        }),
        observation: null,
        lock: null,
        profiles: ["build"],
      },
    );

    expect(report.interrupted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.profiles.build.status).not.toBe("pass");
    expect(report.evidence.map((entry) => [entry.check, entry.status, entry.reason])).toEqual([
      ["a.first", "pass", null],
      ["b.second", "skipped", "cancelled"],
    ]);
  });

  test("a check cut short by cancellation is recorded as cancelled, not as its own failure", async () => {
    const root = project();
    const controller = new AbortController();
    registerChecker("test.killed", async () => {
      controller.abort("SIGTERM");
      return { status: "fail", summary: "exit 143", method: STATIC_METHOD };
    });

    const report = await runVerification(
      createContext({ cwd: tmpdir(), signal: controller.signal }),
      {
        root,
        blueprint: blueprintFixture({
          verification: [contract("k.killed", "test.killed", "build")],
        }),
        observation: null,
        lock: null,
        profiles: ["build"],
      },
    );

    expect(report.evidence[0]).toMatchObject({ status: "skipped", reason: "cancelled" });
    expect(report).toMatchObject({ interrupted: true, ok: false });
  });

  test("a run whose every check finished is not interrupted, though the signal fired during the last one", async () => {
    // Arrange
    const root = project();
    const controller = new AbortController();
    registerChecker("test.cancel-then-pass", async () => {
      controller.abort("SIGINT");
      return { status: "pass", summary: "ok", method: STATIC_METHOD };
    });

    // Act
    const report = await runVerification(
      createContext({ cwd: tmpdir(), signal: controller.signal }),
      {
        root,
        blueprint: blueprintFixture({
          verification: [contract("only.check", "test.cancel-then-pass", "build")],
        }),
        observation: null,
        lock: null,
        profiles: ["build"],
      },
    );

    // Assert
    expect(report).toMatchObject({ interrupted: false, ok: true });
    expect(report.profiles.build.status).toBe("pass");
  });

  test.each([
    ["blocked", "missing toolchain: docker"],
    ["skipped", "no build script in apps/api"],
  ] as const)("a check's own %s result stands when cancellation arrives while it runs", async (status, reason) => {
    // Arrange — the first check ends with its own determination as the signal
    // fires; the second never starts.
    const root = project();
    const controller = new AbortController();
    registerChecker(`test.cancel-then-${status}`, async () => {
      controller.abort("SIGTERM");
      return { status, summary: reason, method: STATIC_METHOD, reason };
    });

    // Act
    const report = await runVerification(
      createContext({ cwd: tmpdir(), signal: controller.signal }),
      {
        root,
        blueprint: blueprintFixture({
          verification: [
            contract("own.result", `test.cancel-then-${status}`, "build"),
            contract("never.run", `test.cancel-then-${status}`, "build"),
          ],
        }),
        observation: null,
        lock: null,
        profiles: ["build"],
      },
    );

    // Assert
    expect(report.evidence.map((entry) => [entry.check, entry.status, entry.reason])).toEqual([
      ["own.result", status, reason],
      ["never.run", "skipped", "cancelled"],
    ]);
    expect(report).toMatchObject({ interrupted: true, ok: false });
  });

  test("a complete run is not interrupted", async () => {
    const root = project();
    const blueprint = blueprintFixture();
    const report = await runVerification(ctx(), {
      root,
      blueprint,
      observation: null,
      lock: null,
      profiles: ["structural"],
      extra: defaultContracts(blueprint),
    });
    expect(report.interrupted).toBe(false);
    expect(VerificationReport.safeParse(report).success).toBe(true);
  });
});

const STATIC_METHOD = { kind: "static" as const, tool: "test", command: null };

function contract(
  id: string,
  checker: string,
  profile: "build" | "runtime",
  needs: { credentials?: string[]; toolchains?: string[] } = {},
): VerificationContract {
  return {
    id,
    profile,
    description: id,
    checker,
    capability: null,
    unit: null,
    needs: {
      network: false,
      processes: false,
      credentials: needs.credentials ?? [],
      toolchains: needs.toolchains ?? [],
    },
  };
}

describe("server harness", () => {
  test("starts on an ephemeral port, answers, and tears down the whole process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "groot-server-"));
    // The script spawns a grandchild to prove the group sweep reaches it.
    writeFileSync(
      join(dir, "server.ts"),
      `Bun.spawn(["sleep", "60"]);
Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("up") });
console.log("listening");`,
    );
    const port = ephemeralPort();
    const server = await startServer({
      argv: [process.execPath, "server.ts"],
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      port,
      readyPath: "/",
      readyTimeoutMs: 20_000,
      secrets: [],
    });
    expect(await (await fetch(server.baseUrl)).text()).toBe("up");
    const log = await server.stop();
    expect(log).toContain("listening");
    await Bun.sleep(300);
    const survivors = Bun.spawnSync(["pgrep", "-g", String(server.pid)])
      .stdout.toString()
      .trim();
    expect(survivors).toBe("");
  }, 30_000);
});
