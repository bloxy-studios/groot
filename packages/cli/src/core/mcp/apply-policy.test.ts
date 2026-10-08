/**
 * operation_apply over MCP: the calling agent cannot approve external
 * effects for itself. Such a call is refused before anything runs, with the
 * terminal command a person uses to approve them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER = join(import.meta.dir, "testing/fake-server.ts");
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const client = new Client({ name: "groot-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: "pipe" }),
  );
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});

interface ToolCall {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: {
    summary: string;
    error?: { id: string; hint: string | null; details: Record<string, unknown> | null };
    plan?: { planId: string };
  };
}

describe("operation_apply (MCP)", () => {
  test("an agent-supplied external approval is refused before anything runs", async () => {
    // Arrange
    const client = await connect();
    const planned = (await client.callTool({
      name: "plan_add",
      arguments: { capabilities: [{ capability: "auth" }] },
    })) as ToolCall;
    const planId = planned.structuredContent.plan?.planId as string;

    // Act
    const refused = (await client.callTool({
      name: "operation_apply",
      arguments: { planId, allow: ["fs.edit", "external"] },
    })) as ToolCall;
    const status = (await client.callTool({
      name: "operation_status",
      arguments: {},
    })) as ToolCall;

    // Assert
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error?.id).toBe("GROOT_E_POLICY_DENIED");
    expect(refused.structuredContent.error?.details).toMatchObject({ denied: ["external"] });
    expect(refused.content[0]?.text).toContain(`groot apply ${planId} --allow external`);
    expect(status.structuredContent.summary).toBe("No operations yet.");
  }, 60_000);
});
