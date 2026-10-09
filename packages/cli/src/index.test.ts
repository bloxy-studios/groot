/**
 * CLI startup (src/index.ts): v2 commands are imported only when resolved, so
 * `--version`, the v1 commands, and `bun create groot <dir>` load no v2
 * command module and never bootstrap the core; a v2 command loads only
 * itself, and the core (recipes, checkers) is bootstrapped only when it runs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { CLI_ENTRY, json, makeProject } from "./core/discovery/test-projects.ts";

/** Process-level: a few CLI runs per test, generous under a loaded machine. */
const TIMEOUT = 90_000;

/** A preload that records, at exit, every module the process loaded (Bun lists ESM there too). */
const TRACE_PRELOAD = `const { writeFileSync } = require("node:fs");
process.on("exit", () => {
  writeFileSync(process.env.GROOT_TRACE_FILE, JSON.stringify(Object.keys(require.cache)));
});
`;

/** Source modules (paths relative to src/) loaded by `groot <args>`. */
async function loadedModules(args: readonly string[]): Promise<string[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "groot-trace-")));
  const preload = join(dir, "trace.js");
  const trace = join(dir, "modules.json");
  writeFileSync(preload, TRACE_PRELOAD);
  const proc = Bun.spawn([process.execPath, "--preload", preload, CLI_ENTRY, ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1", GROOT_TRACE_FILE: trace },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`groot ${args.join(" ")} exited ${exitCode}: ${stderr}`);
  const src = realpathSync(join(CLI_ENTRY, "..")); // module keys are real paths
  return (JSON.parse(readFileSync(trace, "utf8")) as string[])
    .filter((path) => path.startsWith(`${src}${sep}`))
    .map((path) => relative(src, path).split(sep).join("/"));
}

/** Names of the command modules (src/commands/<name>.ts) among `modules`. */
function commandModules(modules: readonly string[]): string[] {
  return modules
    .filter((path) => /^commands\/[^/]+\.ts$/.test(path))
    .map((path) => path.slice("commands/".length, -".ts".length))
    .sort();
}

describe("CLI startup loads v2 commands lazily", () => {
  test(
    "--version, init --help, and a bun-create destination load no v2 command and no core bootstrap",
    async () => {
      // Arrange
      const invocations = [["--version"], ["init", "--help"], ["my-app", "--help"]];

      // Act
      const loaded = await Promise.all(invocations.map((args) => loadedModules(args)));

      // Assert
      for (const modules of loaded) {
        expect(commandModules(modules)).toEqual(["add", "doctor", "init"]);
        expect(modules).not.toContain("core/bootstrap.ts");
      }
    },
    TIMEOUT,
  );

  test(
    "a v2 command loads only itself, and the core is bootstrapped only when it runs",
    async () => {
      // Arrange
      const project = makeProject({ "package.json": json({ name: "traced", private: true }) });

      // Act
      const help = await loadedModules(["inspect", "--help"]);
      const run = await loadedModules(["inspect", project, "--json"]);

      // Assert
      expect(commandModules(help)).toEqual(["add", "doctor", "init", "inspect"]);
      expect(help).not.toContain("core/bootstrap.ts");
      expect(commandModules(run)).toEqual(["add", "doctor", "init", "inspect"]);
      expect(run).toContain("core/bootstrap.ts");
    },
    TIMEOUT,
  );
});
