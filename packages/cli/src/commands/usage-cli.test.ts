/**
 * Process-level tests for malformed v2 invocations (the machine contract,
 * docs/v2-cli-spec.md#machine-contract): a missing positional, a missing
 * subcommand, or a flag given without a value is a usage error — under
 * --json exactly one GROOT_E_USAGE envelope on stdout and exit 2; without
 * --json the message on stderr, nothing on stdout, and exit 2. None of these
 * needs a project, so they run from an empty directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { removeScratchDirs, runCli, scratchDir } from "../core/executor/test-support.ts";

afterAll(removeScratchDirs);

const PROCESS_TIMEOUT = 180_000;

/** The command's words (its envelope's `command`), then the rest of a malformed invocation. */
const MALFORMED: readonly (readonly [string, readonly string[]])[] = [
  ["plan", []],
  ["plan add", []],
  ["plan add", ["auth", "--target"]],
  ["apply", []],
  ["resume", []],
  ["resume", ["op_x", "--retry-step"]],
  ["rollback", []],
  ["verify", ["--profile"]],
  ["verify", ["--capability"]],
  ["verify", ["--unit"]],
  ["context", ["--task"]],
];

const argv = ([command, rest]: (typeof MALFORMED)[number]): string[] => [
  ...command.split(" "),
  ...rest,
];

describe("malformed v2 invocations (process-level)", () => {
  test(
    "--json: exactly one GROOT_E_USAGE envelope on stdout, exit 2",
    async () => {
      // Arrange
      const cwd = scratchDir("groot-usage-");

      // Act — --json right after the command, so a flag left without a value can't swallow it.
      const runs = await Promise.all(
        MALFORMED.map(([command, rest]) => runCli(cwd, [...command.split(" "), "--json", ...rest])),
      );

      // Assert
      for (const [index, run] of runs.entries()) {
        const entry = MALFORMED[index] as (typeof MALFORMED)[number];
        const [command] = entry;
        const label = argv(entry).join(" ");
        expect({ label, exitCode: run.exitCode }).toEqual({ label, exitCode: 2 });
        const envelope = ResultEnvelope.parse(JSON.parse(run.stdout));
        expect({
          label,
          command: envelope.command,
          ok: envelope.ok,
          id: envelope.error?.id,
        }).toEqual({ label, command, ok: false, id: "GROOT_E_USAGE" });
      }
    },
    PROCESS_TIMEOUT,
  );

  test(
    "without --json: the usage error on stderr, stdout empty, exit 2",
    async () => {
      // Arrange
      const cwd = scratchDir("groot-usage-");

      // Act
      const runs = await Promise.all(MALFORMED.map((entry) => runCli(cwd, argv(entry))));

      // Assert
      for (const [index, run] of runs.entries()) {
        const label = argv(MALFORMED[index] as (typeof MALFORMED)[number]).join(" ");
        expect({ label, exitCode: run.exitCode, stdout: run.stdout }).toEqual({
          label,
          exitCode: 2,
          stdout: "",
        });
        expect(run.stderr).toContain("groot error:");
      }
    },
    PROCESS_TIMEOUT,
  );

  test(
    "an unknown --recipe beside a known one is GROOT_E_UNKNOWN_CAPABILITY in either order",
    async () => {
      // Arrange
      const cwd = scratchDir("groot-usage-");
      const recipes = ["data.drizzle-sqlite", "bogus.recipe"];

      // Act
      const runs = await Promise.all(
        [recipes, [...recipes].reverse()].map(([first, second]) =>
          runCli(cwd, [
            "plan",
            "add",
            "auth",
            "--recipe",
            first as string,
            "--recipe",
            second as string,
            "--json",
          ]),
        ),
      );

      // Assert
      for (const run of runs) {
        expect(run.exitCode).toBe(2);
        const envelope = ResultEnvelope.parse(JSON.parse(run.stdout));
        expect(envelope.error?.id).toBe("GROOT_E_UNKNOWN_CAPABILITY");
        expect(envelope.error?.message).toBe('Unknown recipe "bogus.recipe".');
        expect(envelope.error?.hint).toContain("data.drizzle-sqlite");
      }
    },
    PROCESS_TIMEOUT,
  );
});
