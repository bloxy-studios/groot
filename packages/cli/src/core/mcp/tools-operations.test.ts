/**
 * Operation tools over MCP: a plan applied again after a rollback is linked
 * to the NEW operation (never the rolled-back one), so status and cancel act
 * on what is running; a policy denial's next step retries the tool that was
 * refused — resume and rollback are never sent to operation_apply / `groot
 * apply` — and a class an agent can't approve goes to a person at a terminal.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createApi } from "../api.ts";
import type { Policy } from "../contracts/blueprint.ts";
import { savePlan } from "../executor/index.ts";
import { assertPolicy } from "../executor/policy.ts";
import { addDeps, buildPlan, removeScratchDirs, scratchProject } from "../executor/test-support.ts";
import { nullSink } from "../runtime.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import type { GrootApi } from "./api.ts";
import { JobTracker } from "./jobs.ts";
import { buildServer } from "./server.ts";
import { createFakeApi } from "./testing/fake-api.ts";

interface ToolCall {
  isError?: boolean;
  structuredContent: {
    summary: string;
    next: string[];
    operationId?: string | null;
    state?: string;
    error?: { id: string; details: Record<string, unknown> | null };
    plan?: { planId: string };
    operation?: { status: string };
  };
}

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});
afterAll(removeScratchDirs);

async function connect(api: GrootApi, cwd = process.cwd()): Promise<Client> {
  const server = buildServer({ api, jobs: new JobTracker(), cwd, events: nullSink });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "groot-test", version: "0.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolCall;
}

/** The fake API, with resume refused exactly as the executor refuses it (assertPolicy). */
function resumeDeniedApi(policy: Policy, requiredClasses: Policy["allow"]): GrootApi {
  const base = createFakeApi();
  return {
    ...base,
    async resume(_ctx, root, operationId) {
      const plan = await base.getPlan(root, (await base.readOperation(root, operationId)).planId);
      assertPolicy({ ...plan, requiredClasses }, policy, []);
      throw new Error("expected a policy denial");
    },
  };
}

async function appliedOperation(client: Client): Promise<string> {
  const planned = await call(client, "plan_add", { capabilities: [{ capability: "auth" }] });
  const planId = planned.structuredContent.plan?.planId as string;
  const applied = await call(client, "operation_apply", { planId });
  return applied.structuredContent.operationId as string;
}

describe("operation_apply links the operation it started", () => {
  test("re-applying a rolled-back plan reports — and cancels — the NEW operation", async () => {
    // Arrange — a slow plan applied, cancelled, and rolled back.
    const client = await connect(createFakeApi());
    const planned = await call(client, "plan_add", {
      capabilities: [{ capability: "auth", target: "slow" }],
    });
    const planId = planned.structuredContent.plan?.planId as string;
    const first = await call(client, "operation_apply", { planId, waitMs: 300 });
    const oldId = first.structuredContent.operationId as string;
    await call(client, "operation_cancel", { operationId: oldId });
    await call(client, "operation_rollback", { operationId: oldId, execute: true });

    // Act
    const again = await call(client, "operation_apply", { planId, waitMs: 0 });
    const newId = again.structuredContent.operationId as string;
    const status = await call(client, "operation_status", { operationId: newId, waitMs: 0 });
    const cancelled = await call(client, "operation_cancel", { operationId: newId });
    const old = await call(client, "operation_status", { operationId: oldId, waitMs: 0 });

    // Assert
    expect(again.structuredContent.state).toBe("running");
    expect(newId).toMatch(/^op_/);
    expect(newId).not.toBe(oldId);
    expect(again.structuredContent.next[0]).toContain(`operationId=${newId}`);
    expect(status.structuredContent.operation?.status).toBe("running");
    expect(cancelled.structuredContent.summary).toBe(`Operation ${newId} is interrupted.`);
    expect(cancelled.structuredContent.next[0]).toContain("operation_resume");
    expect(old.structuredContent.operation?.status).toBe("rolled-back");
  }, 60_000);
});

describe("policy denials name the tool that was refused", () => {
  test("a resume denied by policy is retried with operation_resume and allow — never operation_apply", async () => {
    // Arrange
    const filesOnly: Policy = { allow: ["fs.create", "fs.edit"], external: "deny" };
    const client = await connect(resumeDeniedApi(filesOnly, ["command"]));
    const operationId = await appliedOperation(client);

    // Act
    const refused = await call(client, "operation_resume", { operationId });

    // Assert
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error?.id).toBe("GROOT_E_POLICY_DENIED");
    expect(refused.structuredContent.next).toEqual([
      `Ask the user to approve the denied action classes (command), then call operation_resume with operationId=${operationId} and allow=["command"].`,
    ]);
  }, 60_000);

  test("a resume blocked on external effects names `groot resume`, with the step decision kept", async () => {
    // Arrange
    const askExternal: Policy = { allow: ["fs.create", "fs.edit"], external: "ask" };
    const client = await connect(resumeDeniedApi(askExternal, ["external"]));
    const operationId = await appliedOperation(client);

    // Act
    const refused = await call(client, "operation_resume", { operationId, skipStep: "s01" });

    // Assert
    expect(refused.structuredContent.error?.id).toBe("GROOT_E_POLICY_DENIED");
    const next = refused.structuredContent.next.join(" ");
    expect(next).toContain(`groot resume ${operationId} --skip-step s01 --allow external`);
    expect(next).not.toContain("groot apply");
  }, 60_000);

  test("a rollback whose install the policy refuses goes to a person at a terminal (real core)", async () => {
    // Arrange — the policy allows the dependency edit but no install, process, or network.
    const root = scratchProject({ "package.json": '{\n  "name": "demo",\n  "private": true\n}\n' });
    writeFileSync(
      join(root, "groot.json"),
      `${JSON.stringify(blueprintFixture({ policy: { allow: ["fs.edit", "deps.change"], external: "deny" } }), null, 2)}\n`,
    );
    const plan = await buildPlan(root, async (b) => {
      await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
    });
    await savePlan(root, plan);
    const client = await connect(createApi(), root);
    const applied = await call(client, "operation_apply", { planId: plan.planId });
    const operationId = applied.structuredContent.operationId as string;

    // Act
    const refused = await call(client, "operation_rollback", { operationId, execute: true });
    const status = await call(client, "operation_status", { operationId });

    // Assert
    expect(applied.structuredContent.state).toBe("completed");
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error?.id).toBe("GROOT_E_POLICY_DENIED");
    const next = refused.structuredContent.next.join(" ");
    expect(next).toContain(`groot rollback ${operationId} --allow command,install,network`);
    expect(next).not.toContain("operation_apply");
    expect(status.structuredContent.operation?.status).toBe("completed");
  }, 120_000);
});
