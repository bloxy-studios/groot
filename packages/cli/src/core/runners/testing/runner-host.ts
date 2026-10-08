/**
 * Test helper: a minimal host process that starts ONE simulated Claude run
 * (GROOT_CLAUDE_PATH points at the fake) and waits for it — so tests can
 * signal the host the way a closed terminal (SIGHUP) or a supervisor
 * (SIGTERM) would. Prints `spawned <pid>` once the runner exists and
 * `result <status>` when the run ends. With `--abort-on-sigterm` it behaves
 * like the CLI: SIGTERM aborts the run instead of ending the process.
 * Never used by production code.
 *
 *   bun runner-host.ts <cwd> <events-log> [--abort-on-sigterm]
 */
import { getRunner } from "../index.ts";

const [cwd, eventsLogPath, flag] = process.argv.slice(2);
if (cwd === undefined || eventsLogPath === undefined) {
  throw new Error("usage: runner-host.ts <cwd> <events-log> [--abort-on-sigterm]");
}
const controller = new AbortController();
if (flag === "--abort-on-sigterm") process.on("SIGTERM", () => controller.abort("SIGTERM"));

const handle = getRunner("claude-code").start({
  cwd,
  prompt: "simulated task",
  sessionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  limits: { maxTurns: 3, maxBudgetUsd: null, wallTimeMs: 120_000 },
  allowedCommands: [],
  eventsLogPath,
  signal: controller.signal,
  env: process.env,
  grace: { interruptMs: 1000, terminateMs: 1000 },
  onSpawn: (pid) => process.stdout.write(`spawned ${pid}\n`),
});
const result = await handle.result;
process.stdout.write(`result ${result.status}\n`);
