/**
 * Command runner for the generate stage. Generators run with CI=1 so they can
 * never fall back to interactive prompts; failures become EXIT.GENERATOR errors
 * carrying the tail of the captured output.
 */
import type { GeneratorCommand } from "./adapter.ts";
import { EXIT, GrootError } from "./errors.ts";

/** Last `count` non-empty lines of a block of process output. */
export function outputTail(output: string, count = 15): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-count).join("\n");
}

export interface RunOptions {
  /** Stream generator output to the terminal instead of capturing it. */
  readonly verbose: boolean;
}

/**
 * Run one generator command to completion. Throws EXIT.GENERATOR on a non-zero
 * exit, including the captured output tail so failures are diagnosable without
 * re-running.
 */
export async function runCommand(command: GeneratorCommand, options: RunOptions): Promise<void> {
  // CI=1 guarantees non-interactive behavior across generators (create-next-app,
  // create-expo-app, etc. all respect CI detection).
  const env = { ...process.env, CI: "1" };

  // Pre-answered prompt input, or an immediately-closed stdin so no generator
  // can ever block waiting for a human.
  const stdin = new TextEncoder().encode(command.stdin ?? "");

  if (options.verbose) {
    const proc = Bun.spawn([...command.argv], {
      cwd: command.cwd,
      env,
      stdin,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new GrootError(
        `${command.label} failed (exit ${exitCode}): ${command.argv.join(" ")}`,
        EXIT.GENERATOR,
      );
    }
    return;
  }

  const proc = Bun.spawn([...command.argv], {
    cwd: command.cwd,
    env,
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const tail = outputTail(`${stdout}\n${stderr}`);
    throw new GrootError(
      `${command.label} failed (exit ${exitCode}): ${command.argv.join(" ")}${tail ? `\n${tail}` : ""}`,
      EXIT.GENERATOR,
      "Re-run with --verbose to stream the full generator output.",
    );
  }
}
