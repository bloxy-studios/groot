/**
 * Process-level tests for `groot schema`: one JSON envelope on stdout, the
 * contract index with published URLs, a contract's JSON Schema by name, and
 * a stable error id + exit code for unknown names.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelope } from "../core/contracts/envelope.ts";

const CLI_ENTRY = join(import.meta.dir, "../index.ts");

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("groot schema (process-level)", () => {
  test("--json emits exactly one result envelope listing every contract", async () => {
    const { stdout, exitCode } = await runCli(["schema", "--json"]);
    expect(exitCode).toBe(0);
    const envelope = ResultEnvelope.parse(JSON.parse(stdout));
    expect(envelope.ok).toBe(true);
    const data = envelope.data as {
      contracts: { name: string; url: string }[];
      errors: { id: string; exitCode: number }[];
      exitCodes: Record<string, number>;
    };
    expect(data.contracts.map((entry) => entry.name)).toContain("plan");
    expect(data.contracts.find((entry) => entry.name === "evidence")?.url).toBe(
      "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/v2/evidence.schema.json",
    );
    expect(data.errors.find((entry) => entry.id === "GROOT_E_STALE_PLAN")?.exitCode).toBe(6);
    expect(data.exitCodes).toMatchObject({
      OK: 0,
      CONFLICT: 6,
      BLOCKED: 7,
      LOCKED: 8,
      CANCELLED: 130,
    });
  }, 60_000);

  test("a named contract prints its JSON Schema", async () => {
    const { stdout, exitCode } = await runCli(["schema", "plan", "--json"]);
    expect(exitCode).toBe(0);
    const envelope = ResultEnvelope.parse(JSON.parse(stdout));
    expect((envelope.data as { $id: string }).$id).toBe(
      "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/v2/plan.schema.json",
    );
  }, 60_000);

  test("an unknown contract is GROOT_E_NOT_FOUND with exit 2, stdout still one envelope", async () => {
    const { stdout, exitCode } = await runCli(["schema", "nope", "--json"]);
    expect(exitCode).toBe(2);
    const envelope = ResultEnvelope.parse(JSON.parse(stdout));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.id).toBe("GROOT_E_NOT_FOUND");
  }, 60_000);
});
