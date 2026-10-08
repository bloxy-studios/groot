/**
 * Process-level recovery tests: real hard crashes injected with the test-only
 * GROOT_INTERNAL_CRASH_AT hook (SIGKILL right after a step's intent, or right
 * after its effect), then `groot resume` — the final tree must equal an
 * uninterrupted run's, with no effect duplicated. Plus the non-idempotent
 * command gate and SIGINT during a long command (exit 130, the child's whole
 * process group gone, then resume completes).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationPlan } from "../core/contracts/plan.ts";
import {
  addCommand,
  buildPlan,
  envelopeOf,
  journalRecords,
  operationIds,
  runCli,
  scratchProject,
  snapshot,
  spawnCli,
  stateFile,
  waitFor,
  writePlanFile,
} from "../core/executor/test-support.ts";

const PROCESS_TIMEOUT = 180_000;
const FILES = { "README.md": "# Demo\n" };

/** s01 write · s02 precomputed edit (file step) · s03 command · s04 write (a step after). */
async function recoveryPlan(
  root: string,
  command: string,
  idempotent: boolean,
): Promise<OperationPlan> {
  return buildPlan(root, async (b) => {
    await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
    await b.editFile({
      path: "README.md",
      edit: { kind: "lines", lines: ["Managed by groot."], header: null },
      description: "edit README.md",
      owns: [],
      createIfMissing: false,
    });
    addCommand(b, command, { touches: ["log.txt"], idempotent, description: "append to log.txt" });
    await b.writeFile({ path: "z.txt", content: "z\n", description: "create z.txt" });
  });
}

const GUARDED_APPEND = "grep -qx ran log.txt 2>/dev/null || echo ran >> log.txt";
const PLAIN_APPEND = "echo ran >> log.txt";

/** The tree an uninterrupted run of the same plan produces. */
async function referenceTree(
  command: string,
  idempotent: boolean,
): Promise<ReturnType<typeof snapshot>> {
  const root = scratchProject(FILES);
  const run = await runCli(root, [
    "apply",
    writePlanFile(await recoveryPlan(root, command, idempotent)),
  ]);
  expect(run.exitCode).toBe(0);
  return snapshot(root);
}

async function crashAt(
  point: string,
  command: string,
  idempotent: boolean,
): Promise<{ root: string; operationId: string }> {
  const root = scratchProject(FILES);
  const planFile = writePlanFile(await recoveryPlan(root, command, idempotent));
  const crashed = await runCli(root, ["apply", planFile], { GROOT_INTERNAL_CRASH_AT: point });
  expect(crashed.signalCode).toBe("SIGKILL");
  const [operationId] = operationIds(root);
  return { root, operationId: String(operationId) };
}

function lastDoneOutcome(root: string, operationId: string, stepId: string): string | null {
  const done = journalRecords(root, operationId).filter(
    (record) => record.type === "step.done" && record.stepId === stepId,
  );
  const last = done.at(-1);
  return last?.type === "step.done" ? last.outcome : null;
}

describe("crash recovery via GROOT_INTERNAL_CRASH_AT (process-level)", () => {
  const scenarios = [
    { point: "s02:after-intent", outcome: "applied", label: "file step, before its effect" },
    { point: "s02:after-effect", outcome: "reconciled", label: "file step, after its effect" },
    {
      point: "s03:after-intent",
      outcome: "applied",
      label: "idempotent command, before its effect",
    },
    {
      point: "s03:after-effect",
      outcome: "applied",
      label: "idempotent command, after its effect",
    },
  ] as const;

  for (const scenario of scenarios) {
    test(
      `${scenario.label}: resume ends in the uninterrupted state with no duplicated effect`,
      async () => {
        // Arrange
        const expected = await referenceTree(GUARDED_APPEND, true);
        const { root, operationId } = await crashAt(scenario.point, GUARDED_APPEND, true);
        const stepId = scenario.point.slice(0, 3);
        const crashedState = stateFile(root, operationId);

        // Act
        const resumed = await runCli(root, ["resume", operationId, "--json"]);

        // Assert
        expect(crashedState.status).toBe("running"); // the snapshot the dead process left
        expect(crashedState.currentStep).toBe(stepId);
        expect(resumed.exitCode).toBe(0);
        expect(envelopeOf(resumed).data.status).toBe("completed");
        expect(lastDoneOutcome(root, operationId, stepId)).toBe(scenario.outcome);
        expect(snapshot(root)).toEqual(expected);
        expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("ran\n");
      },
      PROCESS_TIMEOUT,
    );
  }

  test(
    "a non-idempotent command cut off mid-run blocks resume until --skip-step",
    async () => {
      // Arrange
      const expected = await referenceTree(PLAIN_APPEND, false);
      const { root, operationId } = await crashAt("s03:after-effect", PLAIN_APPEND, false);

      // Act
      const blocked = await runCli(root, ["resume", operationId, "--json"]);
      const skipped = await runCli(root, ["resume", operationId, "--skip-step", "s03", "--json"]);

      // Assert
      expect(blocked.exitCode).toBe(7);
      const envelope = envelopeOf(blocked);
      expect(envelope.error?.id).toBe("GROOT_E_BLOCKED");
      expect(envelope.error?.details?.stepId).toBe("s03");
      expect(envelope.blocked[0]?.resolveWith).toContain("--retry-step s03");
      expect(envelope.blocked[0]?.resolveWith).toContain("--skip-step s03");
      expect(skipped.exitCode).toBe(0);
      expect(snapshot(root)).toEqual(expected);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a non-idempotent command that never ran is re-run with --retry-step",
    async () => {
      // Arrange
      const expected = await referenceTree(PLAIN_APPEND, false);
      const { root, operationId } = await crashAt("s03:after-intent", PLAIN_APPEND, false);

      // Act
      const blocked = await runCli(root, ["resume", operationId]);
      const retried = await runCli(root, ["resume", operationId, "--retry-step", "s03"]);

      // Assert
      expect(blocked.exitCode).toBe(7);
      expect(blocked.stderr).toContain("--retry-step s03");
      expect(retried.exitCode).toBe(0);
      expect(snapshot(root)).toEqual(expected);
    },
    PROCESS_TIMEOUT,
  );
});

/** pgrep -g lists the members of a process group (exit 1 when there are none). */
function groupMembers(pgid: number): string[] {
  const result = Bun.spawnSync(["pgrep", "-g", String(pgid)]);
  return new TextDecoder()
    .decode(result.stdout)
    .trim()
    .split("\n")
    .filter((line) => line !== "");
}

describe.skipIf(process.platform === "win32")(
  "SIGINT during a long command (process-level)",
  () => {
    test(
      "exits 130, leaves the operation interrupted with no surviving child group, then resume completes",
      async () => {
        // Arrange — the first run records its pid and blocks; the resumed run sees the marker and exits 0.
        const outside = mkdtempSync(join(tmpdir(), "groot-sigint-"));
        const pidFile = join(outside, "pid");
        const marker = join(outside, "marker");
        const root = scratchProject(FILES);
        const planFile = writePlanFile(
          await buildPlan(root, async (b) => {
            await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
            addCommand(
              b,
              `echo $$ > '${pidFile}'; if [ -f '${marker}' ]; then exit 0; fi; touch '${marker}'; sleep 30 & sleep 30`,
              { idempotent: true, timeoutMs: 120_000, description: "long-running command" },
            );
            await b.writeFile({ path: "b.txt", content: "b\n", description: "create b.txt" });
          }),
        );

        // Act
        const cli = spawnCli(root, ["apply", planFile]);
        await waitFor(
          () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
          60_000,
          "the command to start",
        );
        const pgid = Number(readFileSync(pidFile, "utf8").trim());
        const membersWhileRunning = groupMembers(pgid);
        cli.proc.kill("SIGINT");
        const interrupted = await cli.done;
        const [operationId] = operationIds(root);
        const state = stateFile(root, String(operationId));
        const survivors = groupMembers(pgid);
        const resumed = await runCli(root, ["resume", String(operationId)]);

        // Assert
        expect(membersWhileRunning.length).toBeGreaterThanOrEqual(2);
        expect(interrupted.exitCode).toBe(130);
        expect(state.status).toBe("interrupted");
        expect(state.currentStep).toBe("s02");
        expect(survivors).toEqual([]);
        expect(resumed.exitCode).toBe(0);
        expect(stateFile(root, String(operationId)).status).toBe("completed");
        expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\n");
      },
      PROCESS_TIMEOUT,
    );
  },
);
