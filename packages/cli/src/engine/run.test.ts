import { describe, expect, test } from "bun:test";
import { EXIT, GrootError } from "./errors.ts";
import { outputTail, runCommand } from "./run.ts";

const bunExe = process.execPath;

describe("outputTail", () => {
  test("keeps the last non-empty lines", () => {
    const output = "one\ntwo\n\nthree\n\n";
    expect(outputTail(output, 2)).toBe("two\nthree");
  });

  test("handles empty output", () => {
    expect(outputTail("")).toBe("");
  });
});

describe("runCommand", () => {
  test("resolves on exit 0", async () => {
    await runCommand(
      { argv: [bunExe, "-e", "process.exit(0)"], cwd: process.cwd(), label: "noop" },
      { verbose: false },
    );
  });

  test("throws EXIT.GENERATOR with the output tail on failure", async () => {
    try {
      await runCommand(
        {
          argv: [bunExe, "-e", "console.error('boom: disk full'); process.exit(7)"],
          cwd: process.cwd(),
          label: "exploder",
        },
        { verbose: false },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      const grootError = error as GrootError;
      expect(grootError.exitCode).toBe(EXIT.GENERATOR);
      expect(grootError.message).toContain("exploder failed (exit 7)");
      expect(grootError.message).toContain("boom: disk full");
      expect(grootError.hint).toContain("--verbose");
    }
  });

  test("runs in the requested cwd with CI=1", async () => {
    await runCommand(
      {
        argv: [
          bunExe,
          "-e",
          `if (process.env.CI !== "1") process.exit(1); if (!process.cwd().endsWith("tmp")) process.exit(2);`,
        ],
        cwd: "/tmp",
        label: "env check",
      },
      { verbose: false },
    );
  });
});
