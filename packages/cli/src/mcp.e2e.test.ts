/**
 * Groot MCP end to end (Gate D): the official MCP client drives the real
 * `groot mcp` server over stdio — real core API, real recipes, real installs —
 * through the agent workflow the tools advertise:
 *
 *   describe → project_inspect → plan_add auth → operation_apply (+ status
 *   polling) → verify_run (all four profiles) → evidence_get → context_get
 *   (no secret values) → plan_context_sync → operation_apply
 *
 * A non-JSON byte on the server's stdout would break the client transport, so
 * completing the flow also proves protocol-clean stdout under real work.
 *
 *   GROOT_E2E=1 bun test mcp.e2e
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const e2e = process.env.GROOT_E2E === "1";
const CLI = join(import.meta.dir, "index.ts");
const TIMEOUT = 900_000;

type Structured = { summary: string; next: string[]; [key: string]: unknown };

let client: Client | null = null;

afterAll(async () => {
  await client?.close().catch(() => {});
});

/** Call a tool; fail the test with the tool's own error text when it reports one. */
async function call(name: string, args: Record<string, unknown>): Promise<Structured> {
  const result = (await (client as Client).callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Structured;
    content?: { type: string; text?: string }[];
  };
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error(
      `${name} failed: ${result.content?.map((part) => part.text ?? "").join("\n") ?? "(no content)"}`,
    );
  }
  return result.structuredContent;
}

/** operation_apply, then poll operation_status until the operation settles. */
async function applyAndWait(root: string, planId: string): Promise<Structured> {
  let result = await call("operation_apply", { root, planId, waitMs: 45_000 });
  while (result.state === undefined || result.state === "running") {
    expect(typeof result.operationId).toBe("string");
    result = await call("operation_status", {
      root,
      operationId: result.operationId,
      waitMs: 45_000,
    });
  }
  return result;
}

describe.skipIf(!e2e)("groot mcp end to end (official client, real project)", () => {
  test(
    "an agent adds auth+data, proves the product flow, and syncs context — all over MCP",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "groot-mcp-e2e-"));
      const init = Bun.spawnSync(
        [process.execPath, CLI, "init", "svc", "--topology", "single", "--api", "hono", "--yes"],
        { cwd: base, stdout: "pipe", stderr: "pipe" },
      );
      expect(init.exitCode).toBe(0);
      const root = join(base, "svc");

      client = new Client(
        { name: "groot-e2e", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI, "mcp"],
          cwd: root,
          stderr: "pipe",
        }),
      );

      const described = await call("describe", {});
      expect(JSON.stringify(described)).toContain("auth");

      const inspected = await call("project_inspect", { root });
      expect(
        (inspected.observation as { registration: { status: string } }).registration.status,
      ).toBe("v2");

      const planned = await call("plan_add", { root, capabilities: [{ capability: "auth" }] });
      const plan = planned.plan as { planId: string; selections: string[]; actions: unknown[] };
      expect(plan.selections.map((selection) => selection.split(" ")[0])).toEqual(["data", "auth"]);
      expect(plan.actions.length).toBeGreaterThan(0);

      const applied = await applyAndWait(root, plan.planId);
      expect(applied.state).toBe("completed");

      const verified = await call("verify_run", {
        root,
        profiles: ["structural", "build", "runtime", "product-flow"],
      });
      const profiles = verified.profiles as Record<string, { status: string }>;
      expect(profiles["product-flow"]?.status).toBe("pass");
      expect(profiles.runtime?.status).toBe("pass");
      expect(verified.summary).toContain("found no failures");
      const flow = (verified.evidence as { id: string; check: string }[]).find(
        (entry) => entry.check === "auth.flow",
      );
      expect(flow).toBeDefined();
      const record = await call("evidence_get", { root, id: (flow as { id: string }).id });
      expect(JSON.stringify(record)).toContain("pass");

      // Task context names variables and where they live — never their values.
      const secretLine = (await readFile(join(root, ".env.local"), "utf8"))
        .split("\n")
        .find((line) => line.startsWith("BETTER_AUTH_SECRET="));
      const secret = secretLine?.slice("BETTER_AUTH_SECRET=".length) ?? "";
      expect(secret.length).toBeGreaterThan(16);
      const context = await call("context_get", { root, task: "add a notes search endpoint" });
      expect(JSON.stringify(context)).toContain("BETTER_AUTH_SECRET");
      expect(JSON.stringify(context)).not.toContain(secret);

      const sync = await call("plan_context_sync", { root });
      const syncPlan = sync.plan as { planId: string };
      expect((await applyAndWait(root, syncPlan.planId)).state).toBe("completed");
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
        "groot:begin project-context",
      );
      expect((await call("plan_context_sync", { root })).summary).toBe(
        "Agent context is already in sync.",
      );
    },
    TIMEOUT,
  );
});
