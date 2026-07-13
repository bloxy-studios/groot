/**
 * Process-level tests for `groot init`'s non-interactive contract
 * (docs/cli-spec.md#non-interactive-contract-ci--agents): spawn the real CLI
 * with piped stdio — the CI/agent environment — and assert it never hangs on
 * prompts, keeps `--json` stdout pure, and routes the bun-create bare-destination
 * form to init. Dry runs only: no generator ever executes here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION } from "../engine/types.ts";

const CLI_ENTRY = join(import.meta.dir, "../index.ts");

/** Run the CLI from source with piped (non-TTY) stdio; capture everything. */
async function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "groot-init-cli-"));
}

describe("groot init (process-level, non-TTY)", () => {
  test("--public without --github → exit 2 with the pairing hint", async () => {
    const cwd = await scratch();
    const { stderr, exitCode } = await runCli(cwd, [
      "init",
      "app",
      "--yes",
      "--public",
      "--dry-run",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--public only applies together with --github");
  });

  test("--github with --no-git → exit 2 (the push needs the initial commit)", async () => {
    const cwd = await scratch();
    const { stderr, exitCode } = await runCli(cwd, [
      "init",
      "app",
      "--yes",
      "--github",
      "--no-git",
      "--dry-run",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--github needs the initial commit");
  });

  test("--github shows in the dry-run plan summary (private by default, public opt-in)", async () => {
    const cwd = await scratch();
    const priv = await runCli(cwd, ["init", "app", "--yes", "--github", "--dry-run"]);
    expect(priv.exitCode).toBe(0);
    expect(priv.stdout).toContain("github     create private repo + push");
    const pub = await runCli(cwd, ["init", "app", "--yes", "--github", "--public", "--dry-run"]);
    expect(pub.stdout).toContain("github     create public repo + push");
  });

  test("prompts are never attempted without a TTY — exits 2 with the flag hint", async () => {
    const cwd = await scratch();
    const { stderr, exitCode } = await runCli(cwd, ["init", "my-app"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("TTY");
    expect(stderr).toContain("--yes");
  });

  test("--yes without a target directory exits 2 instead of prompting", async () => {
    const cwd = await scratch();
    const { stderr, exitCode } = await runCli(cwd, ["init", "--yes"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Target directory required");
  });

  test("--dry-run --json emits the plan on pure stdout; diagnostics on stderr", async () => {
    const cwd = await scratch();
    const { stdout, stderr, exitCode } = await runCli(cwd, [
      "init",
      "app",
      "--web",
      "next",
      "--mobile",
      "none",
      "--desktop",
      "none",
      "--api",
      "none",
      "--backend",
      "none",
      "--dry-run",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const plan = JSON.parse(stdout); // throws if stdout isn't pure JSON
    expect(plan.version).toBe(MANIFEST_VERSION);
    expect(plan.scaffolds).toHaveLength(1);
    expect(plan.scaffolds.at(0)?.framework).toBe("next");
    // Preflight check lines land on stderr in --json mode.
    expect(stderr).toContain("bun");
  });

  test("--json without --dry-run exits 2", async () => {
    const cwd = await scratch();
    const { stderr, exitCode } = await runCli(cwd, ["init", "app", "--yes", "--json"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--json currently requires --dry-run");
  });

  test("bun-create bare-destination form routes to init", async () => {
    const cwd = await scratch();
    // `bun create groot my-app` invokes the bin with just a destination.
    const { stdout, exitCode } = await runCli(cwd, ["my-app", "--yes", "--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("my-app");
    expect(stdout).toContain("dry run — nothing was written");
  });

  test("a --preset run with a target dir is fully non-interactive", async () => {
    const cwd = await scratch();
    const presetPath = join(cwd, "shape.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          $schema: MANIFEST_SCHEMA_URL,
          version: MANIFEST_VERSION,
          createdWith: "create-groot@0.4.0",
          conventions: { packagesNamespace: "@repo" },
          scaffolds: [
            {
              slot: "api",
              framework: "elysia",
              path: "apps/api",
              generator: null,
              port: 3001,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const { stdout, stderr, exitCode } = await runCli(cwd, [
      "init",
      "app",
      "--preset",
      presetPath,
      "--dry-run",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.scaffolds).toHaveLength(1);
    expect(plan.scaffolds.at(0)?.framework).toBe("elysia");
    // The preset line is a diagnostic — stderr, not stdout.
    expect(stderr).toContain("preset");
  });
});
