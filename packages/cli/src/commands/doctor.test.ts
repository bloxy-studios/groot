/**
 * Process-level tests for `groot doctor`'s machine-readable contract: spawn
 * the real CLI (non-TTY, piped stdio) against fixture workspaces and assert
 * the spec'd exit codes (0 healthy / 5 problems / 2 no workspace) and `--json`
 * stdout purity.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION, type PlannedScaffold } from "../engine/types.ts";

const CLI_ENTRY = join(import.meta.dir, "../index.ts");

const WEB_NEXT: PlannedScaffold = {
  slot: "web",
  framework: "next",
  path: "apps/web",
  generator: "create-next-app@16",
  port: 3000,
};

/** Minimal on-disk groot workspace (same shape as the engine test fixtures). */
async function workspace(scaffolds: PlannedScaffold[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "groot-doctor-cli-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      { name: "grown", private: true, workspaces: ["apps/*", "packages/*"] },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "turbo.json"),
    `${JSON.stringify({ tasks: { build: { dependsOn: ["^build"] }, dev: { cache: false } } }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "groot.json"),
    `${JSON.stringify(
      {
        $schema: MANIFEST_SCHEMA_URL,
        version: MANIFEST_VERSION,
        createdWith: "create-groot@0.4.0",
        conventions: { packagesNamespace: "@repo" },
        scaffolds,
      },
      null,
      2,
    )}\n`,
  );
  for (const scaffold of scaffolds) {
    await mkdir(join(root, scaffold.path), { recursive: true });
    await writeFile(
      join(root, scaffold.path, "package.json"),
      `${JSON.stringify({ name: basename(scaffold.path), version: "0.0.0" }, null, 2)}\n`,
    );
  }
  return root;
}

async function runDoctor(
  cwd: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "doctor", ...args], {
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

describe("groot doctor (process-level, non-TTY)", () => {
  test("healthy workspace → exit 0 (warnings allowed)", async () => {
    const root = await workspace([WEB_NEXT]);
    const { stdout, exitCode } = await runDoctor(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Healthy");
  });

  test("--json emits structured results on pure stdout", async () => {
    const root = await workspace([WEB_NEXT]);
    const { stdout, exitCode } = await runDoctor(root, ["--json"]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout); // throws if stdout isn't pure JSON
    expect(report.healthy).toBe(true);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
  });

  test("problems → exit 5, and --json says healthy: false", async () => {
    const root = await workspace([WEB_NEXT]);
    // A nested lockfile is a spec'd hard failure (one root lockfile only).
    await writeFile(join(root, "apps/web/bun.lock"), "");
    const { stdout, exitCode } = await runDoctor(root, ["--json"]);
    expect(exitCode).toBe(5);
    const report = JSON.parse(stdout);
    expect(report.healthy).toBe(false);
    const lockCheck = report.checks.find(
      (check: { name: string }) => check.name === "nested lockfiles",
    );
    expect(lockCheck?.status).toBe("fail");
  });

  test("outside any groot workspace → exit 2", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "groot-doctor-nowhere-"));
    const { stderr, exitCode } = await runDoctor(cwd);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("No groot workspace found");
  });
});
