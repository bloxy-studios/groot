/**
 * Process supervision: after a child exits (or is cancelled) its whole
 * process group is swept, so background jobs a script started neither
 * survive nor keep runProcess waiting on their open output pipes.
 * POSIX only (process groups); skipped on Windows.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("a forced exit (second Ctrl-C) SIGKILLs groups still running, SIGTERM-ignoring ones included", async () => {
    // Arrange — a host process starts a SIGTERM-ignoring command, then exits
    // mid-run the way runV2Command's second SIGINT does (process.exit).
    const dir = await mkdtemp(join(tmpdir(), "groot-forced-exit-"));
    const pidFile = join(dir, "pgid");
    const host = `
      import { runProcess } from ${JSON.stringify(join(import.meta.dir, "process.ts"))};
      void runProcess({
        argv: ["sh", "-c", "trap '' TERM; echo $$ > ${pidFile}; sleep 30 & wait"],
        cwd: ${JSON.stringify(dir)},
        timeoutMs: 60_000,
      });
      const deadline = Date.now() + 10_000;
      while (!(await Bun.file(${JSON.stringify(pidFile)}).exists()) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      process.exit(130);
    `;

    // Act
    const proc = Bun.spawn([process.execPath, "-e", host], { stdout: "ignore", stderr: "pipe" });
    const exitCode = await proc.exited;
    const pgid = Number((await readFile(pidFile, "utf8")).trim());
    const deadline = Date.now() + 2000;
    while (isProcessGroupAlive(pgid) && Date.now() < deadline) await Bun.sleep(25);

    // Assert
    expect(exitCode).toBe(130);
    expect(groupMembers(pgid)).toEqual([]);
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

  test("a secret split across two writes is redacted in captured and streamed output", async () => {
    // Arrange
    const secret = "abcdef1234567890";
    const streamed: string[] = [];

    // Act
    const result = await runProcess({
      argv: [
        "sh",
        "-c",
        "printf 'abcdef12'; sleep 0.3; printf '34567890\\n'; printf 'BETTER_AUTH_SECRET='; sleep 0.3; printf 'hunter2hunter2\\n'; printf 'tail'",
      ],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      secrets: [secret],
      onOutput: (chunk) => streamed.push(chunk),
    });

    // Assert
    const expected = "[REDACTED]\nBETTER_AUTH_SECRET=[REDACTED]\ntail";
    expect(result.stdout).toBe(expected);
    expect(streamed.join("")).toBe(expected);
  }, 30_000);

  test("the capture cap drops whole lines from the head, never part of a secret", async () => {
    // Arrange
    const secret = "abcdef1234567890";

    // Act
    const result = await runProcess({
      argv: [
        "sh",
        "-c",
        "printf 'abcdef12'; sleep 0.3; printf '34567890\\nsecond line\\nthird\\n'",
      ],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      secrets: [secret],
      captureLimit: 24,
    });

    // Assert
    expect(result.stdout).toBe("second line\nthird\n");
  }, 30_000);

  test("the capture cap keeps the tail of a line rewritten with carriage returns", async () => {
    // Arrange: progress output redraws one line; the failure follows on the same line.
    const script =
      "i=0; while [ $i -lt 200 ]; do printf 'progress %s\\r' $i; i=$((i+1)); done; printf 'ERROR: the real failure message'";

    // Act
    const result = await runProcess({
      argv: ["sh", "-c", script],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      captureLimit: 500,
    });

    // Assert
    expect(result.stdout.endsWith("progress 199\rERROR: the real failure message")).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(500);
    expect(result.stdout.startsWith("progress ")).toBe(true);
  }, 30_000);
});

describe("runProcess timeouts", () => {
  test("a timeout beyond setTimeout's range never fires immediately", async () => {
    // setTimeout runs a callback at once when its delay exceeds 2^31-1 ms.
    const result = await runProcess({
      argv: ["sh", "-c", "sleep 0.2; echo done"],
      cwd: tmpdir(),
      timeoutMs: 3_000_000_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
  });
});
