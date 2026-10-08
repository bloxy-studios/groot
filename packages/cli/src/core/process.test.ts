/**
 * Process supervision: after a child exits (or is cancelled) its whole
 * process group is swept, so background jobs a script started neither
 * survive nor keep runProcess waiting on their open output pipes.
 * POSIX only (process groups); skipped on Windows.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { isProcessGroupAlive, runProcess, sweepProcessGroup } from "./process.ts";

const posix = process.platform !== "win32";

/** pgrep -g exits 1 when no process has that process-group id. */
function groupMembers(pgid: number): string[] {
  const result = Bun.spawnSync(["pgrep", "-g", String(pgid)]);
  return new TextDecoder()
    .decode(result.stdout)
    .trim()
    .split("\n")
    .filter((line) => line !== "");
}

describe.skipIf(!posix)("runProcess group supervision", () => {
  test("a background job left behind by a finished command is swept, promptly", async () => {
    // Arrange
    const started = Date.now();

    // Act
    const result = await runProcess({
      argv: ["sh", "-c", "sleep 30 & echo started"],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      killGraceMs: 2000,
    });

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("started");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.pid).not.toBeNull();
    expect(groupMembers(result.pid as number)).toEqual([]);
    expect(isProcessGroupAlive(result.pid as number)).toBe(false);
  }, 30_000);

  test("abort terminates the whole group, grandchildren included", async () => {
    // Arrange
    const controller = new AbortController();

    // Act
    const result = await runProcess({
      argv: ["sh", "-c", "sleep 30 & echo ready; sleep 30"],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      signal: controller.signal,
      killGraceMs: 2000,
      onOutput: (chunk) => {
        if (chunk.includes("ready")) controller.abort("SIGINT");
      },
    });

    // Assert
    expect(result.aborted).toBe(true);
    expect(groupMembers(result.pid as number)).toEqual([]);
  }, 30_000);

  test("sweepProcessGroup escalates to SIGKILL for a group that ignores SIGTERM", async () => {
    // Arrange
    const proc = Bun.spawn(["sh", "-c", "trap '' TERM; echo ready; sleep 30 & wait"], {
      stdout: "pipe",
      detached: true,
    });
    const reader = proc.stdout.getReader();
    await reader.read();

    // Act
    await sweepProcessGroup(proc.pid, 500);
    await proc.exited;

    // Assert
    expect(groupMembers(proc.pid)).toEqual([]);
  }, 30_000);

  test("captured output is redacted with known secrets", async () => {
    // Arrange
    const secret = "s3cr3t-value-that-is-long";

    // Act
    const result = await runProcess({
      argv: ["sh", "-c", `echo token=${secret}`],
      cwd: tmpdir(),
      timeoutMs: 10_000,
      secrets: [secret],
    });

    // Assert
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("[REDACTED]");
  });
});
