import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck } from "./adapter.ts";
import { isHealthy, runDoctor } from "./doctor.ts";
import { loadManifest } from "./manifest.ts";
import { MANIFEST_SCHEMA_URL } from "./types.ts";

/** Write a fully healthy flagship-style workspace (next + elysia + convex). */
async function healthyWorkspace(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "groot-doctor-"));
  const write = async (relPath: string, contents: string): Promise<void> => {
    const absPath = join(base, relPath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  };

  await write(
    "groot.json",
    JSON.stringify({
      $schema: MANIFEST_SCHEMA_URL,
      version: 1,
      createdWith: "create-groot@0.2.1",
      conventions: { packagesNamespace: "@repo" },
      scaffolds: [
        {
          slot: "web",
          framework: "next",
          path: "apps/web",
          generator: "create-next-app@16",
          port: 3000,
        },
        { slot: "api", framework: "elysia", path: "apps/api", generator: null, port: 3001 },
        {
          slot: "backend",
          framework: "convex",
          path: "packages/backend",
          generator: null,
          port: null,
        },
      ],
    }),
  );
  await write(
    "package.json",
    JSON.stringify({ name: "demo", private: true, workspaces: ["apps/*", "packages/*"] }),
  );
  await write("turbo.json", JSON.stringify({ tasks: { build: {}, dev: {} } }));
  await write("bun.lock", "{}");

  await write("apps/web/package.json", JSON.stringify({ name: "web", private: true }));
  await write("apps/web/next.config.ts", "export default {};\n");

  await write("apps/api/package.json", JSON.stringify({ name: "api", private: true }));
  await write("apps/api/src/index.ts", 'new Elysia().get("/", () => "hi").listen(3001);\n');

  await write(
    "packages/backend/package.json",
    JSON.stringify({
      name: "@repo/backend",
      private: true,
      devDependencies: { "@types/node": "^24.12.2" },
    }),
  );
  await write(
    "packages/backend/convex/tsconfig.json",
    JSON.stringify({ compilerOptions: { types: ["node"] } }),
  );
  await write("packages/backend/convex/_generated/api.d.ts", "// generated\n");
  await write("packages/backend/.env.local", "CONVEX_DEPLOYMENT=dev:x\n");
  return base;
}

function byName(checks: readonly DoctorCheck[], name: string): DoctorCheck | undefined {
  return checks.find((check) => check.name === name);
}

describe("doctor (docs/cli-spec.md#groot-doctor-v03)", () => {
  test("a healthy workspace passes every check", async () => {
    const root = await healthyWorkspace();
    const checks = await runDoctor(await loadManifest(root));
    const fails = checks.filter((check) => check.status === "fail");
    const warns = checks.filter((check) => check.status === "warn");
    expect(fails).toEqual([]);
    expect(warns).toEqual([]);
    expect(isHealthy(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(9);
  });

  test("flags nested lockfiles with a fix", async () => {
    const root = await healthyWorkspace();
    await writeFile(join(root, "apps/web/bun.lock"), "{}");
    const checks = await runDoctor(await loadManifest(root));
    const check = byName(checks, "nested lockfiles");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("apps/web/bun.lock");
    expect(check?.fix).toBeDefined();
    expect(isHealthy(checks)).toBe(false);
  });

  test("flags port collisions recorded in the manifest", async () => {
    const root = await healthyWorkspace();
    const manifestPath = join(root, "groot.json");
    const manifest = JSON.parse(await Bun.file(manifestPath).text());
    manifest.scaffolds[1].port = 3000; // api collides with web
    await writeFile(manifestPath, JSON.stringify(manifest));
    const checks = await runDoctor(await loadManifest(root));
    const check = byName(checks, "dev ports");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain(":3000");
  });

  test("missing root lockfile is a warning, not a failure", async () => {
    const root = await healthyWorkspace();
    await rm(join(root, "bun.lock"));
    const checks = await runDoctor(await loadManifest(root));
    expect(byName(checks, "root lockfile")?.status).toBe("warn");
    expect(isHealthy(checks)).toBe(true); // warns keep exit 0 per spec
  });

  test("convex: missing @types/node against a node-typed tsconfig fails (the v0.2.0 field bug)", async () => {
    const root = await healthyWorkspace();
    await writeFile(
      join(root, "packages/backend/package.json"),
      JSON.stringify({ name: "@repo/backend", private: true, devDependencies: {} }),
    );
    const checks = await runDoctor(await loadManifest(root));
    const check = byName(checks, "packages/backend node types");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("@types/node");
  });

  test("convex: missing .env.local is a login-pending warning", async () => {
    const root = await healthyWorkspace();
    await rm(join(root, "packages/backend/.env.local"));
    const checks = await runDoctor(await loadManifest(root));
    const check = byName(checks, "packages/backend deployment");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("bun run setup");
  });

  test("api port drift is a warning with a manifest-sync fix", async () => {
    const root = await healthyWorkspace();
    await writeFile(join(root, "apps/api/src/index.ts"), "new Elysia().listen(4000);\n");
    const checks = await runDoctor(await loadManifest(root));
    const check = byName(checks, "apps/api dev port");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("groot.json");
  });

  test("turbo tasks must be a map containing the core build and dev tasks", async () => {
    const root = await healthyWorkspace();
    for (const broken of [
      { tasks: [] }, // array is not a task map
      { tasks: {} }, // empty
      { tasks: { build: {} } }, // dev missing
    ]) {
      await writeFile(join(root, "turbo.json"), JSON.stringify(broken));
      const checks = await runDoctor(await loadManifest(root));
      expect(byName(checks, "turbo config")?.status).toBe("fail");
    }
    await writeFile(join(root, "turbo.json"), JSON.stringify({ tasks: { build: {}, dev: {} } }));
    const healthy = await runDoctor(await loadManifest(root));
    expect(byName(healthy, "turbo config")?.status).toBe("pass");
  });

  test("broken turbo.json and missing workspace globs fail", async () => {
    const root = await healthyWorkspace();
    await writeFile(join(root, "turbo.json"), "not json");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", workspaces: ["apps/*"] }),
    );
    const checks = await runDoctor(await loadManifest(root));
    expect(byName(checks, "turbo config")?.status).toBe("fail");
    const globs = byName(checks, "workspace globs");
    expect(globs?.status).toBe("fail");
    expect(globs?.detail).toContain("packages/*");
  });
});
