import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  allFrameworkIds,
  buildAddPlan,
  executeAdd,
  frameworkChoice,
  growWithRollback,
  normalizeScaffoldPath,
  readRootPackageName,
  resolveAddScaffold,
} from "./add.ts";
import { EXIT, GrootError } from "./errors.ts";
import { growScaffold } from "./generate.ts";
import { type LoadedManifest, loadManifest } from "./manifest.ts";
import {
  type FrameworkId,
  MANIFEST_SCHEMA_URL,
  MANIFEST_VERSION,
  type Plan,
  type PlannedScaffold,
} from "./types.ts";

const TEST_CREATED_WITH = "create-groot@0.1.0-test";

/** The manifest/plan entry a framework's matrix metadata implies. */
function entryFor(framework: FrameworkId): PlannedScaffold {
  const choice = frameworkChoice(framework);
  if (choice === undefined) throw new Error(`unknown framework ${framework}`);
  return {
    slot: choice.slot,
    framework: choice.meta.id,
    path: choice.meta.path,
    generator: choice.meta.generator,
    port: choice.meta.port,
  };
}

/** A minimal on-disk groot workspace: root package.json, turbo.json, groot.json, scaffold dirs. */
async function workspace(
  scaffolds: PlannedScaffold[],
): Promise<{ root: string; loaded: LoadedManifest }> {
  const root = await mkdtemp(join(tmpdir(), "groot-add-"));
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
  const manifest = {
    $schema: MANIFEST_SCHEMA_URL,
    version: MANIFEST_VERSION,
    createdWith: TEST_CREATED_WITH,
    conventions: { packagesNamespace: "@repo" },
    scaffolds,
  };
  await writeFile(join(root, "groot.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const scaffold of scaffolds) {
    await mkdir(join(root, scaffold.path, "src"), { recursive: true });
    await writeFile(
      join(root, scaffold.path, "package.json"),
      `${JSON.stringify(
        { name: basename(scaffold.path), version: "0.0.0", dependencies: {} },
        null,
        2,
      )}\n`,
    );
  }
  return { root, loaded: await loadManifest(root) };
}

/** Run `fn` (sync or async) and assert it throws a GrootError with EXIT.USAGE containing `fragment`. */
async function expectUsage(
  fn: () => unknown | Promise<unknown>,
  fragment: string,
): Promise<GrootError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GrootError);
    const grootError = error as GrootError;
    expect(grootError.exitCode).toBe(EXIT.USAGE);
    expect(grootError.message).toContain(fragment);
    return grootError;
  }
  throw new Error(`expected a GrootError containing "${fragment}"`);
}

describe("frameworkChoice / allFrameworkIds", () => {
  test("maps ids to their slots", () => {
    expect(frameworkChoice("next")?.slot).toBe("web");
    expect(frameworkChoice("expo")?.slot).toBe("mobile");
    expect(frameworkChoice("hono")?.slot).toBe("api");
    expect(frameworkChoice("convex")?.slot).toBe("backend");
    expect(frameworkChoice("angular")).toBeUndefined();
  });

  test("allFrameworkIds lists every choice and never 'none'", () => {
    const ids = allFrameworkIds();
    expect(ids.sort()).toEqual([
      "astro",
      "convex",
      "electron",
      "elysia",
      "expo",
      "hono",
      "next",
      "sveltekit",
      "tanstack-start",
      "tauri",
    ]);
  });
});

describe("normalizeScaffoldPath", () => {
  const root = "/ws";

  test("accepts direct children of apps/ and packages/, normalizing the input", () => {
    expect(normalizeScaffoldPath("apps/marketing", root)).toBe("apps/marketing");
    expect(normalizeScaffoldPath("./apps/marketing", root)).toBe("apps/marketing");
    expect(normalizeScaffoldPath("apps/marketing/", root)).toBe("apps/marketing");
    expect(normalizeScaffoldPath("packages/tooling", root)).toBe("packages/tooling");
    // Absolute paths are fine as long as they stay inside the workspace.
    expect(normalizeScaffoldPath("/ws/apps/marketing", root)).toBe("apps/marketing");
  });

  test("rejects paths outside the workspace or outside the workspace globs", async () => {
    await expectUsage(() => normalizeScaffoldPath("", root), "cannot be empty");
    await expectUsage(() => normalizeScaffoldPath("../outside", root), "inside the workspace");
    await expectUsage(() => normalizeScaffoldPath("/elsewhere/app", root), "inside the workspace");
    await expectUsage(() => normalizeScaffoldPath(".", root), "inside the workspace");
    await expectUsage(
      () => normalizeScaffoldPath("apps", root),
      "direct child of apps/ or packages/",
    );
    await expectUsage(
      () => normalizeScaffoldPath("apps/a/b", root),
      "direct child of apps/ or packages/",
    );
    await expectUsage(
      () => normalizeScaffoldPath("services/worker", root),
      "direct child of apps/ or packages/",
    );
  });
});

describe("resolveAddScaffold — occupancy matrix", () => {
  test("unknown framework → EXIT.USAGE with the valid ids", async () => {
    const { root, loaded } = await workspace([]);
    const error = await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "angular", undefined),
      'Unknown scaffold "angular"',
    );
    expect(error.hint).toContain(
      "next | sveltekit | tanstack-start | astro | expo | tauri | electron | elysia | hono | convex",
    );
  });

  test("free slot, no --path → the framework's standard destination", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    const { scaffold, warnings } = await resolveAddScaffold(
      loaded.manifest,
      root,
      "elysia",
      undefined,
    );
    expect(scaffold).toEqual({
      slot: "api",
      framework: "elysia",
      path: "apps/api",
      generator: null,
      port: 3001,
    });
    expect(warnings).toEqual([]);
  });

  test("occupied slot without --path → EXIT.USAGE naming the occupant", async () => {
    const { root, loaded } = await workspace([entryFor("elysia")]);
    const error = await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "hono", undefined),
      "api slot is already filled by elysia at apps/api",
    );
    expect(error.hint).toContain("--path");
  });

  test("occupied slot with a fresh --path → allowed, with a port-collision warning", async () => {
    const { root, loaded } = await workspace([entryFor("elysia")]);
    const { scaffold, warnings } = await resolveAddScaffold(
      loaded.manifest,
      root,
      "hono",
      "apps/gateway",
    );
    expect(scaffold.path).toBe("apps/gateway");
    expect(scaffold.generator).toBe("create-hono@0.19");
    expect(scaffold.port).toBe(3001);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3001");
    expect(warnings[0]).toContain("apps/api");
  });

  test("no port warning when ports are unique or null", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    const expo = await resolveAddScaffold(loaded.manifest, root, "expo", undefined);
    expect(expo.warnings).toEqual([]);
    const convex = await resolveAddScaffold(loaded.manifest, root, "convex", undefined);
    expect(convex.warnings).toEqual([]);
  });

  test("the backend slot is single-occupancy — --path is no escape hatch", async () => {
    const { root, loaded } = await workspace([entryFor("convex")]);
    const error = await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "convex", "packages/data"),
      "backend slot is already filled",
    );
    expect(error.hint).toContain("@repo/backend");
  });

  test("--path equal to an existing scaffold's path → EXIT.USAGE", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "sveltekit", "apps/web"),
      "already belongs to the next scaffold",
    );
  });

  test("--path outside the slot's conventional tree → EXIT.USAGE", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "sveltekit", "packages/site"),
      "web scaffolds live under apps/",
    );
  });

  test("non-empty destination → EXIT.USAGE (default and overridden paths alike)", async () => {
    const { root, loaded } = await workspace([]);
    await mkdir(join(root, "apps/api"), { recursive: true });
    await writeFile(join(root, "apps/api/leftover.txt"), "not fresh");
    await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "elysia", undefined),
      "apps/api already exists and is not empty",
    );
    await expectUsage(
      () => resolveAddScaffold(loaded.manifest, root, "hono", "apps/api"),
      "apps/api already exists and is not empty",
    );
  });

  test("an existing but EMPTY destination is fresh", async () => {
    const { root, loaded } = await workspace([]);
    await mkdir(join(root, "apps/api"), { recursive: true });
    const { scaffold } = await resolveAddScaffold(loaded.manifest, root, "elysia", undefined);
    expect(scaffold.path).toBe("apps/api");
  });
});

describe("readRootPackageName", () => {
  test("reads the current root package name", async () => {
    const { root } = await workspace([]);
    expect(await readRootPackageName(root)).toBe("grown");
  });

  test("falls back to the directory basename when the name field is absent", async () => {
    const { root } = await workspace([]);
    await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true })}\n`);
    expect(await readRootPackageName(root)).toBe(basename(root));
  });

  test("throws EXIT.USAGE when the root package.json is unreadable", async () => {
    const { root } = await workspace([]);
    await writeFile(join(root, "package.json"), "{ not json");
    await expectUsage(() => readRootPackageName(root), "Could not read");
  });
});

describe("buildAddPlan", () => {
  test("preserves provenance and appends the new scaffold", async () => {
    const { loaded } = await workspace([entryFor("next")]);
    const scaffold = entryFor("convex");
    const plan = buildAddPlan(loaded, scaffold, "grown", {
      install: false,
      keepFailed: true,
      verbose: false,
    });

    // createdWith records which CLI planted the workspace — never re-stamped by add.
    expect(plan.createdWith).toBe(TEST_CREATED_WITH);
    expect(plan.name).toBe("grown");
    expect(plan.targetDir).toBe(loaded.workspaceRoot);
    expect(plan.conventions).toEqual({ packagesNamespace: "@repo" });
    expect(plan.scaffolds).toHaveLength(2);
    expect(plan.scaffolds.at(-1)).toEqual(scaffold);
    // add never initializes git; the other switches flow through.
    expect(plan.options.git).toBe(false);
    expect(plan.options.install).toBe(false);
    expect(plan.options.keepFailed).toBe(true);
  });
});

describe("growWithRollback", () => {
  async function scaffoldDirWithJunk(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), "groot-rollback-"));
    const dir = join(base, "apps/api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "partial.ts"), "// partial output");
    return dir;
  }

  test("on failure, removes only the scaffold dir and augments the error", async () => {
    const dir = await scaffoldDirWithJunk();
    try {
      await growWithRollback(dir, false, () => {
        throw new GrootError("generator exploded", EXIT.GENERATOR);
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      expect((error as GrootError).exitCode).toBe(EXIT.GENERATOR);
      expect((error as GrootError).message).toContain("partially-grown scaffold was removed");
      expect((error as GrootError).hint).toContain("--keep-failed");
    }
    expect(existsSync(dir)).toBe(false);
    // The workspace above the scaffold dir is untouched.
    expect(existsSync(join(dir, ".."))).toBe(true);
  });

  test("--keep-failed keeps the dir and rethrows the original error", async () => {
    const dir = await scaffoldDirWithJunk();
    const original = new GrootError("generator exploded", EXIT.GENERATOR, "original hint");
    try {
      await growWithRollback(dir, true, () => {
        throw original;
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBe(original);
    }
    expect(existsSync(join(dir, "partial.ts"))).toBe(true);
  });

  test("non-GrootError failures still roll back and rethrow unwrapped", async () => {
    const dir = await scaffoldDirWithJunk();
    const original = new Error("ENOSPC");
    try {
      await growWithRollback(dir, false, () => {
        throw original;
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBe(original);
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("success leaves the dir alone", async () => {
    const dir = await scaffoldDirWithJunk();
    await growWithRollback(dir, false, async () => {});
    expect(existsSync(join(dir, "partial.ts"))).toBe(true);
  });
});

describe("growScaffold", () => {
  test("throws EXIT.INTERNAL for a framework without a registered adapter", async () => {
    const { root } = await workspace([]);
    const plan: Plan = {
      name: "grown",
      targetDir: root,
      createdWith: TEST_CREATED_WITH,
      conventions: { packagesNamespace: "@repo" },
      scaffolds: [],
      options: {
        install: false,
        git: false,
        dirConflict: "error",
        keepFailed: false,
        verbose: false,
      },
    };
    const rogue: PlannedScaffold = {
      slot: "api",
      framework: "angular" as FrameworkId,
      path: "apps/api",
      generator: null,
      port: null,
    };
    try {
      await growScaffold(plan, rogue, { verbose: false });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      expect((error as GrootError).exitCode).toBe(EXIT.INTERNAL);
    }
  });
});

// Elysia and Convex are direct-write adapters (no generator command), so the
// full add pipeline — grow → stitch → verify — runs offline here. The real
// generators are exercised by scenario 3 in generate.e2e.test.ts.
describe("executeAdd (offline, real adapters)", () => {
  test("grows elysia into an existing workspace and updates groot.json", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    const { scaffold } = await resolveAddScaffold(loaded.manifest, root, "elysia", undefined);
    const plan = buildAddPlan(loaded, scaffold, await readRootPackageName(root), {
      install: false,
      keepFailed: false,
      verbose: false,
    });

    const steps: string[] = [];
    const notes = await executeAdd(plan, scaffold, {
      verbose: false,
      onStep: (label) => steps.push(label),
    });

    expect(await readFile(join(root, "apps/api/src/index.ts"), "utf8")).toContain(".listen(3001)");
    const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
    expect(manifest.scaffolds).toHaveLength(2);
    expect(manifest.createdWith).toBe(TEST_CREATED_WITH);
    const rootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(rootPkg.name).toBe("grown");
    expect(notes.join("\n")).toContain("groot.json written");
    expect(steps.length).toBeGreaterThanOrEqual(2);
  });

  test("adding convex wires the EXISTING web app to the backend (full stitch)", async () => {
    const { root, loaded } = await workspace([entryFor("next")]);
    const { scaffold } = await resolveAddScaffold(loaded.manifest, root, "convex", undefined);
    const plan = buildAddPlan(loaded, scaffold, await readRootPackageName(root), {
      install: false,
      keepFailed: false,
      verbose: false,
    });

    await executeAdd(plan, scaffold, { verbose: false });

    expect(existsSync(join(root, "packages/backend/convex/_generated/api.d.ts"))).toBe(true);
    const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
    expect(webPkg.dependencies["@repo/backend"]).toBe("workspace:*");
    expect(await readFile(join(root, ".env.example"), "utf8")).toContain("NEXT_PUBLIC_CONVEX_URL=");
    const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
    expect(manifest.scaffolds).toHaveLength(2);
    expect(manifest.scaffolds.at(-1)).toEqual({
      slot: "backend",
      framework: "convex",
      path: "packages/backend",
      generator: null,
      port: null,
    });
  });
});
