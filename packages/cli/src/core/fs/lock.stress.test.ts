/**
 * Writer-lock mutual exclusion under real contention: several processes
 * acquire and release the same project lock for ~2 s. Inside the critical
 * section each one creates a marker file with O_EXCL — an EEXIST there means
 * two processes held the lock at the same time.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKERS = 5;
const RUN_MS = 2000;
/** Head start so every worker is loaded before the contention window opens. */
const START_DELAY_MS = 1500;

const workerSource = (lockModule: string): string => `
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
const { acquireProjectLock } = await import(${JSON.stringify(lockModule)});
const [root, startAt, stopAt] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const marker = join(root, "inside");
const tally = { acquired: 0, overlaps: 0, refused: 0 };
while (Date.now() < startAt) await Bun.sleep(5);
while (Date.now() < stopAt) {
  let lock;
  try {
    lock = acquireProjectLock(root, { command: "stress", operationId: null });
  } catch (error) {
    if (error?.id !== "GROOT_E_LOCKED") throw error;
    tally.refused++;
    continue;
  }
  tally.acquired++;
  let entered = false;
  try {
    closeSync(openSync(marker, "wx"));
    entered = true;
  } catch {
    tally.overlaps++;
  }
  if (entered) rmSync(marker);
  lock.release();
}
console.log(JSON.stringify(tally));
`;

describe("writer lock under contention", () => {
  test("never lets two processes hold it at once", async () => {
    // Arrange
    const root = realpathSync(mkdtempSync(join(tmpdir(), "groot-lock-stress-")));
    const script = join(root, "worker.ts");
    writeFileSync(script, workerSource(join(import.meta.dir, "lock.ts")));
    const startAt = Date.now() + START_DELAY_MS;
    const stopAt = startAt + RUN_MS;

    // Act
    const workers = Array.from({ length: WORKERS }, () =>
      Bun.spawn([process.execPath, script, root, String(startAt), String(stopAt)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      workers.map(async (worker) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
          worker.exited,
        ]);
        if (exitCode !== 0) throw new Error(`lock worker failed (${exitCode}): ${stderr}`);
        return JSON.parse(stdout.trim()) as { acquired: number; overlaps: number };
      }),
    );

    // Assert
    const acquired = results.reduce((sum, result) => sum + result.acquired, 0);
    const overlaps = results.reduce((sum, result) => sum + result.overlaps, 0);
    expect(acquired).toBeGreaterThan(0);
    expect(overlaps).toBe(0);
  }, 30_000);
});
