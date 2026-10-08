/**
 * Process-level tests for `groot task …` and `groot review` — the real CLI
 * spawned with piped (non-TTY) stdio against a temp git repo and SIMULATED
 * runners: the --json envelope and exit codes for the whole lifecycle,
 * repeatable flags, blocked runners (exit 7), usage errors (exit 2), and
 * SIGINT to a running `groot task run` (exit 130, no surviving runner
 * processes) followed by `groot task resume`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { groupMembers } from "../core/runners/supervise.ts";
import {
  FIXED_MATH,
  removeTempProjects,
  type TempProject,
  tempProject,
} from "../core/tasks/testing/temp-project.ts";

const CLI_ENTRY = join(import.meta.dir, "../index.ts");
const TIMEOUT = 240_000;

afterAll(removeTempProjects);

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function spawnCli(project: TempProject, args: string[]) {
  return Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: project.root,
    env: project.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
}

async function runCli(project: TempProject, args: string[]): Promise<CliRun> {
  const proc = spawnCli(project, args);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function envelopeOf(run: CliRun) {
  const parsed = ResultEnvelope.safeParse(JSON.parse(run.stdout));
  if (!parsed.success) throw new Error(`not an envelope: ${run.stdout}\n${run.stderr}`);
  return parsed.data as typeof parsed.data & { data: Record<string, unknown> };
}

describe("groot task / groot review (process-level, simulated runner)", () => {
  test(
    "create → list → show → run → review --approve → integrate, with envelopes and exit codes",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });

      // Act — create with repeatable flags
      const created = await runCli(project, [
        "task",
        "create",
        "make the failing test pass without changing the test",
        "--accept",
        "bun test",
        "--owns",
        "src/**",
        "--owns=tests/**",
        "--model",
        "opus",
        "--max-turns",
        "12",
        "--max-budget-usd",
        "0.75",
        "--wall-time",
        "600",
        "--json",
      ]);
      const task = envelopeOf(created).data;
      const id = task.id as string;
      const listed = await runCli(project, ["task", "list", "--json"]);
      const shown = await runCli(project, ["task", "show", id]);
      const ran = await runCli(project, ["task", "run", id, "--json", "--events"]);
      const reviewed = await runCli(project, ["review", id, "--approve", "--json"]);
      const integrated = await runCli(project, ["task", "integrate", id, "--json"]);

      // Assert
      expect(created.exitCode).toBe(0);
      expect(task).toMatchObject({
        status: "pending",
        model: "opus",
        ownership: ["src/**", "tests/**"],
        limits: { maxTurns: 12, maxBudgetUsd: 0.75, wallTimeSec: 600, maxAttempts: 2 },
      });
      expect((task.acceptance as { argv: string[] }[])[0]?.argv).toEqual(["bun", "test"]);
      expect(envelopeOf(listed).data).toHaveLength(1);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(id);
      expect(shown.stdout).toContain(`next: groot task run ${id}`);
      expect(ran.exitCode).toBe(0);
      const ranEnvelope = envelopeOf(ran);
      expect(ranEnvelope).toMatchObject({ ok: true, refs: { taskId: id } });
      expect(ranEnvelope.data.status).toBe("awaiting-review");
      expect(ranEnvelope.refs.evidence).toHaveLength(1);
      const events = ran.stderr.split("\n").filter((line) => line.startsWith("{"));
      expect(events.some((line) => JSON.parse(line).type === "task.attempt.started")).toBe(true);
      expect(reviewed.exitCode).toBe(0);
      expect(envelopeOf(reviewed).data).toMatchObject({
        verdict: "approved",
        ownershipViolations: [],
      });
      expect(integrated.exitCode).toBe(0);
      expect(envelopeOf(integrated).data).toMatchObject({
        status: "completed",
        integration: { status: "integrated" },
      });
      expect(readFileSync(join(project.root, "src/math.ts"), "utf8")).toBe(FIXED_MATH);
    },
    TIMEOUT,
  );

  test(
    "SIGINT to a running `groot task run` interrupts it (exit 130, no surviving runner), then `task resume` finishes",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "hang", grandchild: true }] });
      const created = envelopeOf(
        await runCli(project, ["task", "create", "fix add", "--accept", "bun test", "--json"]),
      );
      const id = created.data.id as string;

      // Act — interrupt
      const proc = spawnCli(project, ["task", "run", id, "--json"]);
      const stdout = new Response(proc.stdout).text();
      const stderr = new Response(proc.stderr).text();
      const runnerPid = await project.fakes.waitReady();
      proc.kill("SIGINT");
      const exitCode = await proc.exited;

      // Assert
      expect(exitCode).toBe(130);
      const envelope = envelopeOf({ stdout: await stdout, stderr: await stderr, exitCode });
      expect(envelope).toMatchObject({ ok: false, data: { status: "interrupted" } });
      const stored = JSON.parse(
        readFileSync(join(project.root, ".groot/tasks", id, "task.json"), "utf8"),
      );
      expect(stored.status).toBe("interrupted");
      expect(stored.attempts[0].status).toBe("interrupted");
      expect(() => process.kill(-runnerPid, 0)).toThrow();

      // Act — resume
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const resumed = await runCli(project, ["task", "resume", id, "--json"]);

      // Assert
      expect(resumed.exitCode).toBe(0);
      expect(envelopeOf(resumed).data.status).toBe("awaiting-review");
      const last = project.fakes.records().at(-1);
      expect(last?.argv[last.argv.indexOf("--resume") + 1]).toBe(stored.attempts[0].sessionId);
    },
    TIMEOUT,
  );

  test(
    "a blocked runner exits 7 with the exact cause; usage errors exit 2",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [], auth: "config-error" });
      const created = envelopeOf(
        await runCli(project, ["task", "create", "fix add", "--runner", "codex", "--json"]),
      );
      const id = created.data.id as string;

      // Act
      const blocked = await runCli(project, ["task", "run", id, "--json"]);
      const neither = await runCli(project, ["task", "run"]);
      const shell = await runCli(project, [
        "task",
        "create",
        "x",
        "--accept",
        "bun test && rm -rf /",
      ]);
      const claudeTask = envelopeOf(await runCli(project, ["task", "create", "y", "--json"]));
      const badEffort = await runCli(project, [
        "task",
        "run",
        claudeTask.data.id as string,
        "--effort",
        "ultra",
      ]);

      // Assert
      expect(blocked.exitCode).toBe(7);
      const envelope = envelopeOf(blocked);
      expect(envelope.ok).toBe(false);
      expect(envelope.blocked[0]?.kind).toBe("credential");
      expect(envelope.blocked[0]?.question).toContain("config-incompatible");
      expect(neither.exitCode).toBe(2);
      expect(neither.stderr).toContain("Give a task id or --ready");
      expect(shell.exitCode).toBe(2);
      expect(shell.stderr).toContain("without a shell");
      // An invalid effort is refused before any worktree or runner is touched.
      expect(badEffort.exitCode).toBe(2);
      expect(badEffort.stderr).toContain('Unknown Claude effort "ultra"');
      expect(project.fakes.records()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "`task run --ready` exits non-zero and names a task that could not start",
    async () => {
      // Arrange — a ref the task branch cannot coexist with makes its worktree fail.
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const created = envelopeOf(
        await runCli(project, ["task", "create", "fix add", "--accept", "bun test", "--json"]),
      );
      const id = created.data.id as string;
      await project.git("branch", `groot/task/${id}/blocker`);

      // Act
      const ran = await runCli(project, ["task", "run", "--ready", "--json"]);

      // Assert
      const envelope = envelopeOf(ran);
      expect(ran.exitCode).toBe(4);
      expect(envelope.ok).toBe(false);
      expect(envelope.warnings.join("\n")).toContain(id);
      expect(project.fakes.records()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "wall times and acceptance timeouts beyond 24 hours are refused (exit 2)",
    async () => {
      // Arrange
      const project = await tempProject();

      // Act — 2147484 s is the first value whose milliseconds overflow a timer.
      const wall = await runCli(project, ["task", "create", "x", "--wall-time", "2147484"]);
      const accept = await runCli(project, ["task", "create", "x", "--accept-timeout", "86401"]);
      const listed = envelopeOf(await runCli(project, ["task", "list", "--json"]));

      // Assert
      expect(wall.exitCode).toBe(2);
      expect(wall.stderr).toContain("wallTimeSec");
      expect(accept.exitCode).toBe(2);
      expect(accept.stderr).toContain("86400");
      expect(listed.data as unknown).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "SIGHUP (terminal closed) to `groot task run` takes the runner along; show then reports it interrupted",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({ steps: [{ mode: "hang", grandchild: true }] });
      const created = envelopeOf(
        await runCli(project, ["task", "create", "fix add", "--accept", "bun test", "--json"]),
      );
      const id = created.data.id as string;

      // Act
      const proc = spawnCli(project, ["task", "run", id, "--json"]);
      void new Response(proc.stdout).text();
      void new Response(proc.stderr).text();
      const runnerPid = await project.fakes.waitReady();
      proc.kill("SIGHUP");
      const exitCode = await proc.exited;
      const deadline = Date.now() + 15_000;
      while ((await groupMembers(runnerPid)).length > 0 && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      const shown = envelopeOf(await runCli(project, ["task", "show", id, "--json"]));

      // Assert
      expect(exitCode).toBe(129);
      expect(await groupMembers(runnerPid)).toEqual([]);
      expect(shown.data.status).toBe("interrupted");
    },
    TIMEOUT,
  );

  test(
    "a task overlapping one that runs in another process is blocked (exit 7), nothing starts",
    async () => {
      // Arrange — task A is running in a live process (this test's) on this host.
      const project = await tempProject();
      const a = envelopeOf(
        await runCli(project, ["task", "create", "A", "--owns", "src/**", "--json"]),
      ).data;
      const b = envelopeOf(
        await runCli(project, ["task", "create", "B", "--owns", "src/math.ts", "--json"]),
      ).data;
      const taskDir = join(project.root, ".groot", "tasks", a.id as string);
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ ...a, status: "running" }));
      writeFileSync(
        join(taskDir, "runner.json"),
        JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }),
      );

      // Act
      const ran = await runCli(project, ["task", "run", b.id as string, "--json"]);

      // Assert
      expect(ran.exitCode).toBe(7);
      const envelope = envelopeOf(ran);
      expect(envelope.data.status).toBe("blocked");
      expect(envelope.blocked[0]?.question).toContain(`overlaps running task ${a.id}`);
      expect(project.fakes.records()).toEqual([]);
    },
    TIMEOUT,
  );
});
