/**
 * Process-level tests for `groot add`'s machine-readable contract: spawn the
 * real CLI (non-TTY, piped stdio — the CI/agent environment) against a
 * fixture workspace and assert stdout purity, exit codes, and that dry runs
 * write nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION, type PlannedScaffold } from "../engine/types.ts";

const CLI_ENTRY = join(import.meta.dir, "../index.ts");
const TEST_CREATED_WITH = "create-groot@0.1.0-test";

const WEB_NEXT: PlannedScaffold = {
  slot: "web",
  framework: "next",
  path: "apps/web",
  generator: "create-next-app@16",
  port: 3000,
};
const API_ELYSIA: PlannedScaffold = {
  slot: "api",
  framework: "elysia",
  path: "apps/api",
  generator: null,
  port: 3001,
};

/** Minimal on-disk groot workspace (same shape as the engine test fixtures). */
async function workspace(scaffolds: PlannedScaffold[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "groot-add-cli-"));
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
        createdWith: TEST_CREATED_WITH,
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

/** Run `groot add …` from source in a workspace; capture stdio + exit code. */
async function runAdd(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "add", ...args], {
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

describe("groot add --dry-run --json (process-level)", () => {
  test("stdout is exactly the would-be manifest; diagnostics go to stderr; nothing is written", async () => {
    const root = await workspace([WEB_NEXT]);
    const { stdout, stderr, exitCode } = await runAdd(root, ["elysia", "--dry-run", "--json"]);

    expect(exitCode).toBe(0);
    // Pure machine-readable stdout: parses as the versioned manifest schema.
    const manifest = JSON.parse(stdout);
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.createdWith).toBe(TEST_CREATED_WITH);
    expect(manifest.scaffolds).toHaveLength(2);
    expect(manifest.scaffolds.at(-1)).toEqual(API_ELYSIA);
    // Diagnostics landed on stderr, not stdout.
    expect(stderr).toContain("workspace");
    // Dry run: groot.json on disk is untouched.
    const onDisk = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
    expect(onDisk.scaffolds).toHaveLength(1);
  });

  test("a port-collision warning goes to stderr and never contaminates stdout", async () => {
    const root = await workspace([API_ELYSIA]);
    const { stdout, stderr, exitCode } = await runAdd(root, [
      "hono",
      "--path",
      "apps/gateway",
      "--dry-run",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const manifest = JSON.parse(stdout); // throws if stdout isn't pure JSON
    expect(manifest.scaffolds).toHaveLength(2);
    expect(stderr).toContain("3001");
  });

  test("--json without --dry-run → exit 2", async () => {
    const root = await workspace([WEB_NEXT]);
    const { stderr, exitCode } = await runAdd(root, ["elysia", "--json"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--json currently requires --dry-run");
  });

  test("occupancy refusal keeps its exit code under --json", async () => {
    const root = await workspace([API_ELYSIA]);
    const { stderr, exitCode } = await runAdd(root, ["hono", "--dry-run", "--json"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("already filled");
  });
});
