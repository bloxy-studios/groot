/**
 * Groot v2 acceptance flow (Gate C), black-box through the real CLI:
 *
 *   fresh single-app · fresh monorepo · adopted custom project
 *     → plan add auth (+data) → apply → verify structural/build/runtime/product-flow
 *     → context sync (human text preserved)
 *   + a deliberately crashed apply recovered with `groot resume`
 *   + stale plan refused · re-apply is a no-op · rollback refused after a human edit
 *
 * Real generators and real package installs — network required:
 *   GROOT_E2E=1 bun test v2-flow.e2e
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelope } from "./core/contracts/envelope.ts";

const e2e = process.env.GROOT_E2E === "1";
const CLI = join(import.meta.dir, "index.ts");
const TIMEOUT = 900_000;

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function groot(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Run a v2 command with --json and return its parsed envelope (asserting stdout purity). */
async function json(cwd: string, args: string[], env: Record<string, string> = {}) {
  const run = await groot(cwd, [...args, "--json"], env);
  let envelope: ReturnType<typeof ResultEnvelope.parse>;
  try {
    envelope = ResultEnvelope.parse(JSON.parse(run.stdout));
  } catch (error) {
    throw new Error(
      `groot ${args.join(" ")} did not print one JSON envelope (exit ${run.exitCode}):\n${run.stdout}\n${run.stderr}\n${String(error)}`,
    );
  }
  return { ...run, envelope };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
}

/** plan add auth → apply → verify all profiles; returns the operation id. */
async function addAuthAndProve(root: string): Promise<string> {
  const planned = await json(root, ["plan", "add", "auth"]);
  expect(planned.exitCode).toBe(0);
  const plan = planned.envelope.data as {
    planId: string;
    capabilities: { selections: { capability: string }[] };
  };
  expect(plan.capabilities.selections.map((s) => s.capability)).toEqual(["data", "auth"]);

  const applied = await json(root, ["apply", plan.planId]);
  expect(applied.exitCode).toBe(0);
  const result = applied.envelope.data as { status: string; operationId: string };
  expect(result.status).toBe("completed");

  const verified = await json(root, ["verify", "--profile", "all"]);
  const report = verified.envelope.data as {
    profiles: Record<string, { status: string }>;
    evidence: { check: string; status: string; summary: string }[];
  };
  const notPassing = report.evidence.filter(
    (entry) => entry.status !== "pass" && entry.status !== "skipped",
  );
  expect(notPassing).toEqual([]);
  expect(report.profiles["product-flow"]?.status).toBe("pass");
  expect(report.profiles.runtime?.status).toBe("pass");
  expect(verified.exitCode).toBe(0);
  return result.operationId;
}

async function contextSyncPreserves(root: string, humanLine: string | null): Promise<void> {
  const synced = await json(root, ["context", "sync"]);
  expect(synced.exitCode).toBe(0);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain("groot:begin project-context");
  if (humanLine !== null) expect(agents).toContain(humanLine);
  expect(await readFile(join(root, ".agents/skills/groot/SKILL.md"), "utf8")).toBe(
    await readFile(join(root, ".claude/skills/groot/SKILL.md"), "utf8"),
  );
  const again = await json(root, ["context", "sync"]);
  expect((again.envelope.data as { plan: { actions: unknown[] } }).plan.actions).toHaveLength(0);
}

describe.skipIf(!e2e)("Groot v2 acceptance flow (real generators + installs)", () => {
  test(
    "fresh single-app: create → add auth+data → prove the protected flow → sync context",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "groot-v2-single-"));
      const created = await groot(base, [
        "init",
        "svc",
        "--topology",
        "single",
        "--api",
        "hono",
        "--yes",
      ]);
      expect(created.exitCode).toBe(0);
      const root = join(base, "svc");
      await addAuthAndProve(root);
      await contextSyncPreserves(root, null);
    },
    TIMEOUT,
  );

  test(
    "fresh monorepo: create → add auth+data to apps/api → prove the protected flow",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "groot-v2-mono-"));
      const created = await groot(base, [
        "init",
        "mono",
        "--web",
        "none",
        "--mobile",
        "none",
        "--desktop",
        "none",
        "--api",
        "hono",
        "--backend",
        "none",
        "--yes",
      ]);
      expect(created.exitCode).toBe(0);
      await addAuthAndProve(join(base, "mono"));
    },
    TIMEOUT,
  );

  test(
    "adopted custom project: layout, human instructions, and dirty/staged work survive; auth works",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "groot-v2-adopt-"));
      await mkdir(join(root, "server"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "legacy-api", private: true, type: "module", scripts: { dev: "bun --watch server/main.ts", start: "bun server/main.ts", typecheck: "tsc --noEmit" }, dependencies: { hono: "4.13.13" }, devDependencies: { "@types/bun": "1.4.2", typescript: "5.9.3" } }, null, 2)}\n`,
      );
      await writeFile(
        join(root, "server/main.ts"),
        `import { Hono } from "hono";\n\n// Custom layout: the app lives in server/, not src/.\nconst app = new Hono();\n\napp.get("/", (c) => c.text("legacy api"));\napp.get("/health", (c) => c.json({ ok: true }));\n\nexport default { port: Number(process.env.PORT ?? 4310), fetch: app.fetch };\n`,
      );
      await writeFile(
        join(root, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { lib: ["ESNext"], target: "ESNext", module: "Preserve", moduleResolution: "bundler", types: ["bun"], strict: true, skipLibCheck: true, noEmit: true }, include: ["server"] }, null, 2)}\n`,
      );
      await writeFile(
        join(root, "AGENTS.md"),
        "# Legacy API\n\nHUMAN: always run the health check before deploying.\n",
      );
      await writeFile(join(root, ".gitignore"), "node_modules\n");
      const install = Bun.spawnSync(["bun", "install"], { cwd: root });
      expect(install.exitCode).toBe(0);
      await git(root, ["init", "-q", "-b", "main"]);
      await git(root, ["add", "-A"]);
      await git(root, [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "legacy",
      ]);
      // Dirty + staged human work that adoption must preserve exactly.
      await writeFile(join(root, "NOTES.md"), "staged human notes\n");
      await git(root, ["add", "NOTES.md"]);
      await writeFile(join(root, "server/wip.ts"), "export const wip = true;\n");
      const stagedBefore = await git(root, ["diff", "--cached"]);

      const inspected = await json(root, ["inspect"]);
      const observation = inspected.envelope.data as {
        support: { level: string };
        units: { entry: { value: string } }[];
      };
      expect(observation.support.level).toBe("certified");
      expect(observation.units[0]?.entry.value).toBe("server/main.ts");

      const adopted = await json(root, ["adopt"]);
      expect(adopted.exitCode).toBe(0);
      expect(await git(root, ["diff", "--cached"])).toBe(stagedBefore);
      expect(await readFile(join(root, "server/wip.ts"), "utf8")).toBe(
        "export const wip = true;\n",
      );

      await addAuthAndProve(root);
      expect(await readFile(join(root, "server/main.ts"), "utf8")).toContain('app.get("/health"');
      await contextSyncPreserves(root, "HUMAN: always run the health check before deploying.");
      expect(await git(root, ["diff", "--cached"])).toBe(stagedBefore);
    },
    TIMEOUT,
  );

  test(
    "an apply killed mid-operation resumes to a correct result; stale, re-apply, and rollback rules hold",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "groot-v2-recover-"));
      expect(
        (await groot(base, ["init", "svc", "--topology", "single", "--api", "hono", "--yes"]))
          .exitCode,
      ).toBe(0);
      const root = join(base, "svc");

      const planned = await json(root, ["plan", "add", "auth"]);
      const planId = (planned.envelope.data as { planId: string }).planId;

      // Stale plan: a human edits a file the plan touches → narrow conflict, nothing written.
      const entry = join(root, "src/index.ts");
      const original = await readFile(entry, "utf8");
      await writeFile(entry, `${original}\n// human edit after planning\n`);
      const stale = await json(root, ["apply", planId]);
      expect(stale.exitCode).toBe(6);
      expect(stale.envelope.error?.id).toBe("GROOT_E_STALE_PLAN");
      expect(JSON.stringify(stale.envelope.error?.details)).toContain("src/index.ts");
      expect(existsSync(join(root, ".groot/operations"))).toBe(false);
      await writeFile(entry, original);

      // Crash after the third step's intent is journaled (test-only hook), then resume.
      const fresh = await json(root, ["plan", "add", "auth"]);
      const freshPlan = (fresh.envelope.data as { planId: string }).planId;
      const crashed = await groot(root, ["apply", freshPlan, "--json"], {
        GROOT_INTERNAL_CRASH_AT: "s03:after-intent",
      });
      expect(crashed.exitCode).not.toBe(0);
      const status = await json(root, ["status"]);
      const operations = status.envelope.data as
        | { operationId: string; status: string }[]
        | { operations: { operationId: string }[] };
      const list = Array.isArray(operations) ? operations : operations.operations;
      const operationId = list[0]?.operationId as string;
      const resumed = await json(root, ["resume", operationId]);
      expect(resumed.exitCode).toBe(0);
      expect((resumed.envelope.data as { status: string }).status).toBe("completed");

      // Re-applying the completed plan does nothing.
      const again = await json(root, ["apply", freshPlan]);
      expect((again.envelope.data as { alreadyApplied: boolean }).alreadyApplied).toBe(true);

      // The recovered project actually works end to end.
      const verified = await json(root, ["verify", "--profile", "all"]);
      expect(
        (verified.envelope.data as { profiles: Record<string, { status: string }> }).profiles[
          "product-flow"
        ]?.status,
      ).toBe("pass");

      // Rollback after a human edit to a Groot-written file is refused, changing nothing.
      const authFile = ["src/auth.ts", "src/lib/auth.ts"]
        .map((path) => join(root, path))
        .find((path) => existsSync(path));
      expect(authFile).toBeDefined();
      await writeFile(
        authFile as string,
        `${await readFile(authFile as string, "utf8")}\n// human tweak\n`,
      );
      const rollback = await json(root, ["rollback", operationId]);
      expect(rollback.exitCode).toBe(6);
      expect(rollback.envelope.error?.id).toBe("GROOT_E_ROLLBACK_CONFLICT");
      expect(await readFile(authFile as string, "utf8")).toContain("// human tweak");
    },
    TIMEOUT,
  );
});
