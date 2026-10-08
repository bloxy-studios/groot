/**
 * MCP contract tests against the real `runMcp` server (fake core API):
 * both protocol eras via the official v2 client, truthful tool annotations,
 * structured results with summary + next steps, self-contained GROOT_E_*
 * errors, bounded waits with operation ids for long operations, explicit
 * cancellation, and a raw harness proving stdout carries only JSON-RPC even
 * when core code writes to console.log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER = join(import.meta.dir, "testing/fake-server.ts");
const clients: Client[] = [];

async function connect(era: "legacy" | "modern"): Promise<Client> {
  const client = new Client(
    { name: "groot-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: "pipe" }),
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
