/**
 * The v1 → v2 compatibility path (docs/v2-cli-spec.md#compatibility-with-v1):
 * groot.json v1 and v2 both load; v2 still obeys the v1 scaffold rules;
 * unsupported versions are refused; `add` keeps whichever version a
 * workspace has (never migrating implicitly) and refuses single-app projects;
 * presets accept v2; doctor understands v2 blueprints and single-app
 * projects; `init --topology single` validates its one-app shape up front.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BlueprintV2 } from "./core/contracts/blueprint.ts";
import { planToBlueprint } from "./engine/blueprint.ts";
import { GrootError } from "./engine/errors.ts";
import { validateAnyManifest } from "./engine/manifest.ts";
import { buildPlan } from "./engine/plan.ts";
import { loadPreset } from "./engine/preset.ts";
import type { Plan } from "./engine/types.ts";

const CLI_ENTRY = join(import.meta.dir, "index.ts");
const OPTIONS = {
  install: false,
  git: false,
  dirConflict: "error" as const,
  keepFailed: false,
  verbose: false,
};

function plan(
  selections: Partial<Record<"web" | "mobile" | "desktop" | "api" | "backend", string>>,
): Plan {
  return buildPlan({
    name: "acme",
    targetDir: "/tmp/acme",
    cliVersion: "2.0.0",
    selections: {
      web: "none",
      mobile: "none",
      desktop: "none",
      api: "none",
      backend: "none",
      ...selections,
    },
    options: OPTIONS,
  });
}

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

/** A v2 workspace on disk, written exactly as `init` would write groot.json. */
async function v2Workspace(blueprint: BlueprintV2): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "groot-v2-compat-"));
  const single = blueprint.project.topology === "single";
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(single ? { name: "acme", private: true } : { name: "acme", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2)}\n`,
  );
  if (!single) {
    await writeFile(
      join(root, "turbo.json"),
      `${JSON.stringify({ tasks: { build: {}, dev: {} } })}\n`,
    );
  }
  await writeFile(join(root, "groot.json"), `${JSON.stringify(blueprint, null, 2)}\n`);
  for (const app of blueprint.apps.filter((entry) => entry.path !== ".")) {
    await mkdir(join(root, app.path), { recursive: true });
    await writeFile(
      join(root, app.path, "package.json"),
      `${JSON.stringify({ name: basename(app.path) })}\n`,
    );
  }
  return root;
}

describe("groot.json v1 and v2 both load", () => {
  test("a v1 manifest loads without a blueprint; a v2 blueprint loads with one", () => {
    const v1 = {
      version: 1,
      createdWith: "create-groot@1.10.0",
      conventions: { packagesNamespace: "@repo" },
      scaffolds: [],
    };
    expect(validateAnyManifest(v1, "groot.json").blueprint).toBeNull();
    const v2 = planToBlueprint(plan({ web: "next", backend: "convex" }));
    const loaded = validateAnyManifest(JSON.parse(JSON.stringify(v2)), "groot.json");
    expect(loaded.blueprint?.apps.map((app) => app.id)).toEqual(["web", "backend"]);
    expect(loaded.manifest.scaffolds).toEqual(v2.scaffolds);
  });

  test("v2 still obeys the v1 scaffold rules; unsupported versions are refused", () => {
    const v2 = JSON.parse(JSON.stringify(planToBlueprint(plan({ web: "next" }))));
    v2.scaffolds[0].slot = "api"; // next is not an api framework
    expect(() => validateAnyManifest(v2, "groot.json")).toThrow(/not a known api framework/);
    expect(() => validateAnyManifest({ version: 3 }, "groot.json")).toThrow(
      /reads versions 1 and 2/,
    );
    const broken = JSON.parse(JSON.stringify(planToBlueprint(plan({ web: "next" }))));
    delete broken.project;
    expect(() => validateAnyManifest(broken, "groot.json")).toThrow(GrootError);
  });

  test("fresh backends imply truthful env contracts (names, public scope, the app's own .env.local)", () => {
    const blueprint = planToBlueprint(plan({ web: "next", mobile: "expo", backend: "convex" }));
    expect(
      blueprint.environment.map((contract) => [
        contract.name,
        contract.consumer,
        contract.scope,
        contract.storage,
      ]),
    ).toEqual([
      ["NEXT_PUBLIC_CONVEX_URL", "apps/web", "public", "apps/web/.env.local"],
      ["EXPO_PUBLIC_CONVEX_URL", "apps/mobile", "public", "apps/mobile/.env.local"],
    ]);
  });

  test("presets accept a v2 groot.json", async () => {
    const root = await v2Workspace(planToBlueprint(plan({ web: "sveltekit", api: "hono" })));
    const preset = await loadPreset(root);
    expect(preset.selections).toMatchObject({ web: "sveltekit", api: "hono", backend: "none" });
  });
});

describe("add keeps the workspace's manifest version (process-level)", () => {
  test("a v2 workspace grows its scaffolds AND apps; output validates as a blueprint", async () => {
    const root = await v2Workspace(planToBlueprint(plan({ web: "next" })));
    const { stdout, exitCode } = await runCli(root, ["add", "hono", "--dry-run", "--json"]);
    expect(exitCode).toBe(0);
    const next = BlueprintV2.parse(JSON.parse(stdout));
    expect(next.scaffolds.map((scaffold) => scaffold.framework)).toEqual(["next", "hono"]);
    expect(next.apps.map((app) => [app.id, app.path, app.entry])).toEqual([
      ["web", "apps/web", null],
      ["api", "apps/api", "src/index.ts"],
    ]);
  }, 60_000);

  test("a single-app project refuses `add` with a usage error and a next step", async () => {
    const root = await v2Workspace(
      BlueprintV2.parse({
        ...planToBlueprint({
          ...plan({ api: "hono" }),
          topology: "single",
          scaffolds: [
            {
              slot: "api",
              framework: "hono",
              path: ".",
              generator: "create-hono@0.19",
              port: 3001,
            },
          ],
        }),
      }),
    );
    const { stderr, exitCode } = await runCli(root, ["add", "next", "--dry-run", "--json"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("single-app project");
  }, 60_000);
});

describe("doctor reads v2 (process-level)", () => {
  test("a healthy v2 monorepo passes, and a missing recorded app fails with exit 5", async () => {
    const root = await v2Workspace(planToBlueprint(plan({ web: "next", api: "hono" })));
    const healthy = await runCli(root, ["doctor", "--json"]);
    const report = JSON.parse(healthy.stdout) as {
      healthy: boolean;
      checks: { name: string; status: string }[];
    };
    expect(report.checks.find((check) => check.name === "blueprint apps")?.status).toBe("pass");
    await Bun.$`rm -rf ${join(root, "apps/api")}`.quiet();
    const broken = await runCli(root, ["doctor", "--json"]);
    expect(broken.exitCode).toBe(5);
    expect(JSON.parse(broken.stdout).healthy).toBe(false);
  }, 60_000);
});

describe("init --topology single (process-level, dry runs)", () => {
  test("previews a v2 single-app blueprint with the app at the root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "groot-single-"));
    const { stdout, exitCode } = await runCli(cwd, [
      "init",
      "svc",
      "--topology",
      "single",
      "--api",
      "hono",
      "--dry-run",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const blueprint = BlueprintV2.parse(JSON.parse(stdout));
    expect(blueprint.project.topology).toBe("single");
    expect(blueprint.scaffolds).toEqual([
      { slot: "api", framework: "hono", path: ".", generator: "create-hono@0.19", port: 3001 },
    ]);
    expect(blueprint.apps[0]).toMatchObject({
      path: ".",
      packageName: "svc",
      entry: "src/index.ts",
    });
  }, 60_000);

  test("refuses shapes a single app can't have — before anything is written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "groot-single-"));
    const cases: [string[], RegExp][] = [
      [["--topology", "single", "--dry-run"], /needs one app/],
      [
        ["--topology", "single", "--api", "hono", "--backend", "convex", "--dry-run"],
        /no backend package/,
      ],
      [["--topology", "single", "--web", "next", "--api", "hono", "--dry-run"], /exactly one app/],
      [["--topology", "galaxy", "--yes", "--dry-run"], /Invalid value for --topology/],
    ];
    for (const [flags, message] of cases) {
      const { stderr, exitCode } = await runCli(cwd, ["init", "svc", ...flags]);
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(message);
    }
  }, 120_000);
});
