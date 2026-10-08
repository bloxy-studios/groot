/**
 * The MCP stdout guard, in a subprocess (it rewires the global console): no
 * console method — including the ones Bun writes to stdout — reaches stdout,
 * and counters, timers, and groups still behave, on stderr.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("stdout guard (subprocess)", () => {
  test("after guardStdout no console method writes to stdout; counters and timers still work", async () => {
    const script = `
      const { guardStdout } = await import(${JSON.stringify(join(import.meta.dir, "guard.ts"))});
      guardStdout();
      console.log("via-log"); console.info("via-info"); console.debug("via-debug");
      console.warn("via-warn"); console.error("via-error"); console.trace("via-trace");
      console.dir({ via: "dir" }); console.dirxml("via-dirxml"); console.table([{ via: "table" }]);
      console.count("hits"); console.count("hits"); console.countReset("hits"); console.count("hits");
      console.group("via-group"); console.log("nested"); console.groupCollapsed("inner"); console.groupEnd(); console.groupEnd();
      console.time("timer"); console.timeLog("timer", "via-timeLog"); console.timeEnd("timer");
      console.assert(false, "via-assert"); console.assert(true, "never");
      console.write("via-write\\n"); console.clear();
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    for (const marker of [
      "via-log",
      "via-trace",
      "via: 'dir'",
      "via-dirxml",
      "table",
      "via-group",
      "  nested",
      "via-timeLog",
      "via-assert",
      "via-write",
    ]) {
      expect(stderr).toContain(marker);
    }
    expect(stderr.match(/hits: \d/g)).toEqual(["hits: 1", "hits: 2", "hits: 1"]);
    expect(stderr).toMatch(/timer: [\d.]+ms/);
    expect(stderr).not.toContain("never");
  }, 60_000);
});
