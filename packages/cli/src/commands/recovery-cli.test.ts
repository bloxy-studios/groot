/**
 * Process-level recovery tests: real hard crashes injected with the test-only
 * GROOT_INTERNAL_CRASH_AT hook (SIGKILL right after a step's intent, right
 * after its effect, or in the middle of a staged generator's promotion), then
 * `groot resume` — the final tree must equal an uninterrupted run's, with no
 * effect duplicated. Plus the non-idempotent command gate, generators cut
 * off mid-effect (a human's files at names a promotion had not reached, or
 * inside an entry it had moved, and an in-place generator's partial output:
 * resume decides with a human, deleting nothing), and SIGINT during a long
 * command (exit 130, the child's whole process group gone, then resume
 * completes). A SIGKILLed run's stage lives in a scratch TMPDIR.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OperationPlan } from "../core/contracts/plan.ts";
import {
  addCommand,
  addGenerator,
  buildPlan,
  type CliRun,
  envelopeOf,
  journalRecords,
  operationIds,
  removeScratchDirs,
  runCli,
  scratchDir,
  scratchProject,
  snapshot,
  spawnCli,
  stateFile,
  waitFor,
  writePlanFile,
} from "../core/executor/test-support.ts";

afterAll(removeScratchDirs);

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

describe("generators interrupted mid-effect (process-level)", () => {
  /** A shell script writing `files` (path → one-line content) under `dir`. */
  function writeScript(dir: string, files: Record<string, string>): string {
    return Object.entries(files)
      .map(
        ([path, content]) =>
          `mkdir -p "$(dirname ${dir}/${path})" && echo ${content} > ${dir}/${path}`,
      )
      .join(" && ");
  }

  /**
   * A staged generator promoting `files` into the project root (entry by
   * entry, in name order), then a write.
   */
  async function stagedRootPlan(
    root: string,
    files: Record<string, string> = { "a.txt": "a", "b.txt": "b", "src/c.ts": "c", "d.txt": "d" },
  ): Promise<OperationPlan> {
    const name = basename(root); // a staged generator creates basename(produces) in its stage
    return buildPlan(root, async (b) => {
      addGenerator(b, { script: writeScript(name, files), produces: ".", mode: "staged" });
      await b.writeFile({ path: "z.txt", content: "z\n", description: "create z.txt" });
    });
  }

  /** `groot apply` SIGKILLed right after the promotion's first entry. */
  async function crashMidPromotion(
    root: string,
    plan: OperationPlan,
  ): Promise<{ crashed: CliRun; operationId: string }> {
    const crashed = await runCli(root, ["apply", writePlanFile(plan)], {
      GROOT_INTERNAL_CRASH_AT: "s01:mid-promotion",
      // A SIGKILL skips removing the stage: keep it in a directory this file removes.
      TMPDIR: scratchDir("groot-tmp-"),
    });
    return { crashed, operationId: String(operationIds(root)[0]) };
  }

  test(
    "a staged promotion cut off after one entry: resume removes it and regenerates the whole tree",
    async () => {
      // Arrange
      const reference = scratchProject();
      const uninterrupted = await runCli(reference, [
        "apply",
        writePlanFile(await stagedRootPlan(reference)),
      ]);
      const root = scratchProject();
      const { crashed, operationId } = await crashMidPromotion(root, await stagedRootPlan(root));
      const partial = Object.keys(snapshot(root));

      // Act
      const resumed = await runCli(root, ["resume", operationId, "--json"]);

      // Assert
      expect(uninterrupted.exitCode).toBe(0);
      expect(crashed.signalCode).toBe("SIGKILL");
      expect(partial).toEqual(["a.txt"]);
      expect(resumed.exitCode).toBe(0);
      expect(lastDoneOutcome(root, operationId, "s01")).toBe("applied");
      expect(snapshot(root)).toEqual(snapshot(reference));
    },
    PROCESS_TIMEOUT,
  );

  test(
    "files a human puts at names the cut-off promotion had not reached block resume; nothing is deleted",
    async () => {
      // Arrange
      const root = scratchProject();
      const { crashed, operationId } = await crashMidPromotion(root, await stagedRootPlan(root));
      writeFileSync(join(root, "b.txt"), "my notes\n");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/mine.ts"), "export const mine = 1;\n");
      const meanwhile = snapshot(root);

      // Act
      const resumed = await runCli(root, ["resume", operationId, "--json"]);

      // Assert
      expect(crashed.signalCode).toBe("SIGKILL");
      expect(resumed.exitCode).toBe(7);
      const envelope = envelopeOf(resumed);
      expect(envelope.error?.id).toBe("GROOT_E_BLOCKED");
      expect(envelope.error?.details?.removes).toEqual(["a.txt", "b.txt", "src"]);
      expect(snapshot(root)).toEqual(meanwhile);
      expect(Object.keys(meanwhile)).toEqual(["a.txt", "b.txt", "src/", "src/mine.ts"]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a file a human adds inside an entry the promotion already moved blocks resume; nothing is deleted",
    async () => {
      // Arrange — "app" is promoted first.
      const root = scratchProject();
      const plan = await stagedRootPlan(root, { "app/main.ts": "main", "b.txt": "b" });
      const { crashed, operationId } = await crashMidPromotion(root, plan);
      writeFileSync(join(root, "app/notes.md"), "mine\n");
      const meanwhile = snapshot(root);

      // Act
      const resumed = await runCli(root, ["resume", operationId, "--json"]);

      // Assert
      expect(crashed.signalCode).toBe("SIGKILL");
      expect(resumed.exitCode).toBe(7);
      expect(envelopeOf(resumed).error?.id).toBe("GROOT_E_BLOCKED");
      expect(snapshot(root)).toEqual(meanwhile);
      expect(Object.keys(meanwhile)).toEqual(["app/", "app/main.ts", "app/notes.md"]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "an in-place generator killed mid-run: resume asks instead of deleting; --retry-step regenerates",
    async () => {
      // Arrange — the first run writes part of its output, then kills groot itself.
      const marker = join(scratchDir("groot-gen-marker-"), "ran-once");
      const root = scratchProject();
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          addGenerator(b, {
            script: `mkdir -p src && echo a > src/a.ts && if [ ! -f '${marker}' ]; then touch '${marker}'; kill -9 $PPID; sleep 1; exit 0; fi; echo '<h1/>' > index.html`,
            produces: ".",
            mode: "in-place",
          });
        }),
      );
      const crashed = await runCli(root, ["apply", planFile]);
      const operationId = String(operationIds(root)[0]);
      writeFileSync(join(root, "MY-NOTES.md"), "mine\n");

      // Act
      const withNotes = await runCli(root, ["resume", operationId, "--json"]);
      const notesAfter = readFileSync(join(root, "MY-NOTES.md"), "utf8");
      rmSync(join(root, "MY-NOTES.md"));
      const partialOnly = await runCli(root, ["resume", operationId, "--json"]);
      const retried = await runCli(root, ["resume", operationId, "--retry-step", "s01", "--json"]);

      // Assert
      expect(crashed.signalCode).toBe("SIGKILL");
      for (const run of [withNotes, partialOnly]) {
        expect(run.exitCode).toBe(7);
        expect(envelopeOf(run).error?.id).toBe("GROOT_E_BLOCKED");
        expect(envelopeOf(run).blocked[0]?.resolveWith).toContain("--retry-step s01");
      }
      expect(envelopeOf(withNotes).error?.details?.removes).toEqual(["MY-NOTES.md", "src"]);
      expect(notesAfter).toBe("mine\n");
      expect(retried.exitCode).toBe(0);
      expect(Object.keys(snapshot(root))).toEqual(["index.html", "src/", "src/a.ts"]);
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
        const outside = scratchDir("groot-sigint-");
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
        // The pid file appears before the shell forks its background `sleep`;
        // wait for both members rather than sampling the group too early.
        await waitFor(
          () => groupMembers(pgid).length >= 2,
          10_000,
          "the command's children to start",
        );
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
