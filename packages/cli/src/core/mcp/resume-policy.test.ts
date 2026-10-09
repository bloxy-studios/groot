/**
 * operation_resume over MCP: resume re-checks the action policy for the steps
 * it still runs, so per-run approvals must reach the executor — and, exactly
 * as with operation_apply, the calling agent can never approve external
 * effects for itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ActionClass } from "../contracts/common.ts";
import { nullSink } from "../runtime.ts";
import type { GrootApi } from "./api.ts";
import { JobTracker } from "./jobs.ts";
import { buildServer } from "./server.ts";
import { createFakeApi } from "./testing/fake-api.ts";

interface ToolCall {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: {
    summary: string;
    next?: string[];
    operationId?: string;
    error?: { id: string; details: Record<string, unknown> | null };
    plan?: { planId: string };
  };
}

const clients: Client[] = [];

/** A spy over the fake API: every resume call's options are recorded. */
function spyApi(): { api: GrootApi; resumes: { approvals?: readonly ActionClass[] }[] } {
  const base = createFakeApi();
  const resumes: { approvals?: readonly ActionClass[] }[] = [];
  const api: GrootApi = {
    ...base,
    resume(ctx, root, operationId, options) {
      resumes.push(options);
      return base.resume(ctx, root, operationId, options);
    },
  };
  return { api, resumes };
}

async function connect(api: GrootApi): Promise<Client> {
  const server = buildServer({ api, jobs: new JobTracker(), cwd: process.cwd(), events: nullSink });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "groot-test", version: "0.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function appliedOperation(client: Client): Promise<string> {
  const planned = (await client.callTool({
    name: "plan_add",
    arguments: { capabilities: [{ capability: "auth" }] },
  })) as ToolCall;
  const applied = (await client.callTool({
    name: "operation_apply",
    arguments: { planId: planned.structuredContent.plan?.planId as string },
  })) as ToolCall;
  return applied.structuredContent.operationId as string;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});

describe("operation_resume (MCP)", () => {
  test("per-run approvals reach the executor's resume", async () => {
    // Arrange
    const { api, resumes } = spyApi();
    const client = await connect(api);
    const operationId = await appliedOperation(client);

    // Act
    const resumed = (await client.callTool({
      name: "operation_resume",
      arguments: { operationId, allow: ["command"] },
    })) as ToolCall;

    // Assert
    expect(resumed.isError).toBeFalsy();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.approvals).toEqual(["command"]);
  });

  test("an agent-supplied external approval is refused before resume runs", async () => {
    // Arrange
    const { api, resumes } = spyApi();
    const client = await connect(api);
    const operationId = await appliedOperation(client);

    // Act
    const refused = (await client.callTool({
      name: "operation_resume",
      arguments: { operationId, allow: ["fs.edit", "external"] },
    })) as ToolCall;

    // Assert
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error?.id).toBe("GROOT_E_POLICY_DENIED");
    expect(refused.structuredContent.error?.details).toMatchObject({ denied: ["external"] });
    expect(refused.structuredContent.next?.[0]).toContain(
      `groot resume ${operationId} --allow external`,
    );
    expect(resumes).toHaveLength(0);
  });
});
