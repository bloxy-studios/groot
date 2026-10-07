/**
 * Verification engine: per-profile summaries, truthful skipped/blocked
 * outcomes, evidence persistence with redaction, and the server harness's
 * process-group teardown.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evidence } from "../contracts/evidence.ts";
import { ephemeralPort } from "../ports.ts";
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
});

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
