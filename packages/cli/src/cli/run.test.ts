/**
 * Process-level tests for the shared v2 runner's machine contract (piped
 * stdio, the CI/agent environment): exit 7 always carries blocked[] — a
 * missing choice as an explicit decision, any other blocked error or result
 * as one derived from its error, and a blocked verification check as the
 * prerequisite that resolves it. Human output is collected from the renderer
 * so the runner can write it with an awaited flush (see schema.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { runCli } from "../core/executor/test-support.ts";
import { renderHuman } from "./run.ts";
import { registeredProject as registered } from "./test-support.ts";

const PROCESS_TIMEOUT = 120_000;

async function json(root: string, args: readonly string[]) {
  const run = await runCli(root, [...args, "--json"]);
  return { ...run, envelope: ResultEnvelope.parse(JSON.parse(run.stdout)) };
}

describe("exit 7 always carries blocked[] (process-level)", () => {
  test(
    "a missing choice — several apps fit — is a decision resolved with --target",
    async () => {
      const root = registered(["api", "admin"]);

      const { exitCode, envelope } = await json(root, ["plan", "add", "data"]);

      expect(exitCode).toBe(7);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.id).toBe("GROOT_E_BLOCKED");
      expect(envelope.blocked).toHaveLength(1);
      expect(envelope.blocked[0]).toMatchObject({
        kind: "decision",
        resolveWith: "--target <app>",
      });
      expect(envelope.blocked[0]?.options.map((option) => option.id)).toEqual(["api", "admin"]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a blocked error without decisions of its own gets one derived from its id and hint",
    async () => {
      // Codex's 32 KiB chain budget: context sync refuses with GROOT_E_BLOCKED.
      const nested = `# api\n\n${"x".repeat(31_500)}\n`;
      const root = registered(["api"], {}, { "apps/api/AGENTS.md": nested });

      const { exitCode, envelope } = await json(root, ["context", "sync", "--dry-run"]);

      expect(exitCode).toBe(7);
      expect(envelope.error?.id).toBe("GROOT_E_BLOCKED");
      expect(envelope.blocked).toEqual([
        {
          id: "GROOT_E_BLOCKED",
          kind: "prerequisite",
          question: envelope.error?.message as string,
          options: [],
          resolveWith: envelope.error?.hint as string,
        },
      ]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a blocked verification check is returned as the prerequisite that resolves it",
    async () => {
      const root = registered(["api"], {
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

      const { exitCode, envelope } = await json(root, ["verify", "--profile", "structural"]);

      expect(exitCode).toBe(7);
      expect(envelope.ok).toBe(false);
      expect(envelope.blocked.length).toBeGreaterThan(0);
      expect(envelope.blocked[0]).toMatchObject({ id: "verify.structural.env" });
      expect(envelope.blocked[0]?.resolveWith).toContain("BETTER_AUTH_SECRET");
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a command result that exits 7 without decisions still carries one",
    async () => {
      const script = `
        const { runV2Command } = await import(${JSON.stringify(join(import.meta.dir, "run.ts"))});
        await runV2Command("probe", { json: true, events: false }, async () => ({
          ok: false,
          data: null,
          exitCode: 7,
        }));
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(7);
      const envelope = ResultEnvelope.parse(JSON.parse(stdout));
      expect(envelope.blocked).toHaveLength(1);
      expect(envelope.blocked[0]).toMatchObject({ id: "GROOT_E_BLOCKED", kind: "prerequisite" });
    },
    PROCESS_TIMEOUT,
  );
});

describe("renderHuman", () => {
  test("collects console.log output and returned text, prints nothing itself", () => {
    const log = console.log;

    const text = renderHuman(() => {
      console.log("%s apps", 2);
      console.log();
      return "returned";
    });

    expect(text).toBe("2 apps\n\nreturned\n");
    expect(console.log).toBe(log);
    expect(renderHuman(undefined)).toBe("");
    expect(renderHuman(() => 42)).toBe("");
  });
});
