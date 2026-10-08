/**
 * MCP contract tests against the real `runMcp` server (fake core API):
 * both protocol eras via the official v2 client, truthful tool annotations,
 * structured results with summary + next steps, self-contained GROOT_E_*
 * errors, blocked errors that always carry blocked[] (one plan_add case runs
 * the real core), verify_run results that never call a partial run clean,
 * bounded waits with operation ids for long operations, explicit
 * cancellation, and a raw harness proving stdout carries only JSON-RPC even
 * when core code writes to console.log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  evidenceFixture,
  registeredProject,
  verificationReportFixture,
} from "../../cli/test-support.ts";
import type { BlockedDecision } from "../contracts/envelope.ts";
import { GrootV2Error } from "../errors.ts";
import { createContext } from "../runtime.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { registerChecker, runVerification } from "../verify/engine.ts";
import { fail, ok } from "./results.ts";
import { verificationSummary } from "./tools-project.ts";

const SERVER = join(import.meta.dir, "testing/fake-server.ts");
const CLI_ENTRY = join(import.meta.dir, "../../index.ts");
const clients: Client[] = [];

async function connect(
  era: "legacy" | "modern",
  server: { args: string[]; cwd?: string } = { args: [SERVER] },
): Promise<Client> {
  const client = new Client(
    { name: "groot-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, ...server, stderr: "pipe" }),
  );
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});

type Structured = { summary: string; next: string[]; [key: string]: unknown };
const structured = (result: unknown): Structured =>
  (result as { structuredContent: Structured }).structuredContent;

describe("groot mcp (official client, both eras)", () => {
  for (const era of ["legacy", "modern"] as const) {
    test(`${era}: lists typed tools with truthful annotations and answers describe`, async () => {
      const client = await connect(era);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of [
        "describe",
        "project_inspect",
        "context_get",
        "plan_add",
        "operation_apply",
        "operation_status",
        "operation_cancel",
        "operation_resume",
        "operation_rollback",
        "verify_run",
        "evidence_get",
        "task_create",
        "task_run",
        "task_review",
        "task_integrate",
      ]) {
        expect(byName.has(name)).toBe(true);
      }
      expect(byName.get("describe")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("operation_apply")?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(byName.get("plan_add")?.outputSchema).toBeDefined();
      const described = structured(await client.callTool({ name: "describe", arguments: {} }));
      expect(described.summary).toContain("auth (auth.better-auth)");
    }, 60_000);
  }

  test("plan_add → operation_apply completes and points at verification; re-apply is a no-op", async () => {
    const client = await connect("modern");
    const plan = structured(
      await client.callTool({
        name: "plan_add",
        arguments: { capabilities: [{ capability: "auth" }] },
      }),
    );
    const planId = (plan.plan as { planId: string }).planId;
    expect(plan.next[0]).toContain(`operation_apply with planId=${planId}`);
    const applied = structured(
      await client.callTool({ name: "operation_apply", arguments: { planId } }),
    );
    expect(applied.state).toBe("completed");
    expect(applied.next[0]).toContain("verify_run");
    const again = structured(
      await client.callTool({ name: "operation_apply", arguments: { planId } }),
    );
    expect(again.alreadyApplied).toBe(true);
  }, 60_000);

  test("long operations return an id within waitMs; status polls; cancel stops at a checkpoint", async () => {
    const client = await connect("legacy");
    const plan = structured(
      await client.callTool({
        name: "plan_add",
        arguments: { capabilities: [{ capability: "auth", target: "slow" }] },
      }),
    );
    const planId = (plan.plan as { planId: string }).planId;
    const started = structured(
      await client.callTool({ name: "operation_apply", arguments: { planId, waitMs: 300 } }),
    );
    expect(started.state).toBe("running");
    const operationId = started.operationId as string;
    expect(operationId).toMatch(/^op_/);
    expect(started.next[0]).toContain(`operation_status with operationId=${operationId}`);

    const polled = structured(
      await client.callTool({ name: "operation_status", arguments: { operationId, waitMs: 200 } }),
    );
    expect((polled.operation as { status: string }).status).toBe("running");

    const cancelled = structured(
      await client.callTool({ name: "operation_cancel", arguments: { operationId } }),
    );
    expect(cancelled.summary).toContain("interrupted");
    expect(cancelled.next[0]).toContain("operation_resume");
  }, 60_000);

  test("domain errors are isError results whose first text block is self-contained", async () => {
    const client = await connect("modern");
    const result = (await client.callTool({
      name: "plan_add",
      arguments: { capabilities: [{ capability: "billing" }] },
    })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent: { error: { id: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text.startsWith("GROOT_E_UNKNOWN_CAPABILITY:")).toBe(true);
    expect(result.content[0]?.text).toContain("Next:");
    expect(result.structuredContent.error.id).toBe("GROOT_E_UNKNOWN_CAPABILITY");
  }, 60_000);
});

describe("verify_run results", () => {
  test("a finished run reports its profiles (fake core, over the protocol)", async () => {
    const client = await connect("modern");
    const result = structured(await client.callTool({ name: "verify_run", arguments: {} }));
    expect(result.summary).toContain("found no failures");
    expect(result.interrupted).toBe(false);
  }, 60_000);

  test("an interrupted run is partial — never 'found no failures' — and says to re-run", () => {
    const partial = verificationReportFixture(
      [
        evidenceFixture("build.typecheck.api", "pass"),
        evidenceFixture("build.script.api", "skipped", { reason: "cancelled" }),
      ],
      true,
    );

    const result = verificationSummary(partial);

    expect(result.summary).toContain("INTERRUPTED");
    expect(result.summary).not.toContain("found no failures");
    expect(result.next[0]).toContain("verify_run again");
    expect(result.interrupted).toBe(true);
    const finished = verificationSummary(
      verificationReportFixture([evidenceFixture("build.typecheck.api", "pass")]),
    );
    expect(finished.summary).toContain("found no failures");
  });

  test("a check blocked on credentials still names them after the result redaction (real engine)", async () => {
    // Arrange — the engine's own blocked evidence for a credential that isn't set.
    registerChecker("test.mcp-credentialed", async () => ({
      status: "pass",
      summary: "ok",
      method: { kind: "static", tool: "test", command: null },
    }));
    const report = await runVerification(createContext({ cwd: tmpdir(), env: {} }), {
      root: mkdtempSync(join(tmpdir(), "groot-mcp-verify-")),
      blueprint: blueprintFixture({
        verification: [
          {
            id: "runtime.provider",
            profile: "runtime",
            description: "provider reachable",
            checker: "test.mcp-credentialed",
            capability: null,
            unit: null,
            needs: {
              network: false,
              processes: false,
              credentials: ["PROVIDER_API_KEY"],
              toolchains: [],
            },
          },
        ],
      }),
      observation: null,
      lock: null,
      profiles: ["runtime"],
    });

    // Act — verify_run's result goes through the redaction every tool result gets.
    const result = ok(verificationSummary(report)).structuredContent as {
      evidence: { reason: string | null }[];
      next: string[];
    };

    // Assert
    expect(result.evidence[0]?.reason).toBe("credential not set: PROVIDER_API_KEY");
    expect(result.next[0]).toContain("Set PROVIDER_API_KEY");
  });
});

describe("blocked decisions over MCP (exit 7 ⇒ blocked[])", () => {
  const blockedOf = (result: unknown) =>
    (result as { structuredContent: { blocked: BlockedDecision[] } }).structuredContent.blocked;

  test("fail() passes an error's decisions through, derives one for any other blocked error", () => {
    const decision: BlockedDecision = {
      id: "choice.1",
      kind: "decision",
      question: "Typed persistence fits several apps (api, admin); choose one with --target.",
      options: [],
      resolveWith: "--target <app>",
    };
    const explicit = new GrootV2Error("GROOT_E_BLOCKED", decision.question, {
      blocked: [decision],
    });
    expect(blockedOf(fail(explicit))).toEqual([decision]);

    const denied = new GrootV2Error("GROOT_E_POLICY_DENIED", "The plan needs install.", {
      hint: "Approve install for this run.",
    });
    expect(blockedOf(fail(denied))).toEqual([
      {
        id: "GROOT_E_POLICY_DENIED",
        kind: "policy",
        question: "The plan needs install.",
        options: [],
        resolveWith: "Approve install for this run.",
      },
    ]);

    expect(blockedOf(fail(new GrootV2Error("GROOT_E_NOT_FOUND", "No plan.")))).toEqual([]);
  });

  test("plan_add with several fitting apps answers exit 7 with the decision (real core)", async () => {
    const root = registeredProject(["api", "admin"]);
    const client = await connect("modern", { args: [CLI_ENTRY, "mcp"], cwd: root });

    const result = (await client.callTool({
      name: "plan_add",
      arguments: { capabilities: [{ capability: "data" }] },
    })) as {
      isError?: boolean;
      structuredContent: { error: { id: string; exitCode: number }; blocked: BlockedDecision[] };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ id: "GROOT_E_BLOCKED", exitCode: 7 });
    expect(result.structuredContent.blocked).toHaveLength(1);
    expect(result.structuredContent.blocked[0]).toMatchObject({
      kind: "decision",
      resolveWith: "--target <app>",
    });
  }, 60_000);
});

describe("groot mcp stdout purity (raw harness)", () => {
  test("every stdout line is JSON-RPC; console output from core goes to stderr", async () => {
    const proc = Bun.spawn([process.execPath, SERVER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "describe", arguments: {} },
    });
    await Bun.sleep(3000);
    proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const lines = stdout.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      expect(message.jsonrpc).toBe("2.0");
    }
    const ids = lines
      .map((line) => (JSON.parse(line) as { id?: number }).id)
      .filter((id) => id !== undefined);
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(stdout).not.toContain("noise from core code");
    expect(stderr).toContain("noise from core code");
  }, 60_000);
});
