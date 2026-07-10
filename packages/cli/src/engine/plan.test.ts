import { describe, expect, test } from "bun:test";
import { EXIT, GrootError } from "./errors.ts";
import {
  applyYesDefaults,
  buildPlan,
  buildScaffolds,
  describePlan,
  PACKAGES_NAMESPACE,
  planToManifest,
  undecidedSlots,
  validateSelections,
} from "./plan.ts";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION, type PlanOptions } from "./types.ts";

const OPTIONS: PlanOptions = {
  install: true,
  git: true,
  dirConflict: "error",
  keepFailed: false,
  verbose: false,
};

describe("exit codes (normative — docs/cli-spec.md)", () => {
  test("values are part of the CLI contract", () => {
    expect(EXIT).toEqual({
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      PREFLIGHT: 3,
      GENERATOR: 4,
      STITCH: 5,
      CANCELLED: 130,
    });
  });
});

describe("validateSelections", () => {
  test("accepts valid choices and none", () => {
    expect(() =>
      validateSelections({ web: "sveltekit", mobile: "none", api: "hono", backend: "convex" }),
    ).not.toThrow();
  });

  test("rejects unknown choices with EXIT.USAGE and a hint", () => {
    try {
      validateSelections({ web: "angular" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      const grootError = error as GrootError;
      expect(grootError.exitCode).toBe(EXIT.USAGE);
      expect(grootError.hint).toContain("next");
      expect(grootError.hint).toContain("none");
    }
  });

  test("rejects choices offered by a different slot", () => {
    expect(() => validateSelections({ api: "next" })).toThrow(GrootError);
  });
});

describe("selection resolution", () => {
  test("undecidedSlots lists only missing slots in order", () => {
    expect(undecidedSlots({ web: "next", backend: "convex" })).toEqual(["mobile", "api"]);
    expect(undecidedSlots({})).toEqual(["web", "mobile", "api", "backend"]);
  });

  test("applyYesDefaults fills gaps without overriding explicit picks", () => {
    expect(applyYesDefaults({ api: "elysia" })).toEqual({
      web: "next",
      mobile: "none",
      api: "elysia",
      backend: "convex",
    });
  });
});

describe("buildScaffolds", () => {
  test("skips none slots and preserves slot order", () => {
    const scaffolds = buildScaffolds({
      web: "next",
      mobile: "none",
      api: "elysia",
      backend: "convex",
    });
    expect(scaffolds.map((s) => s.slot)).toEqual(["web", "api", "backend"]);
    expect(scaffolds.map((s) => s.framework)).toEqual(["next", "elysia", "convex"]);
  });

  test("carries path, port, and generator metadata", () => {
    const scaffolds = buildScaffolds({
      web: "sveltekit",
      mobile: "expo",
      api: "none",
      backend: "none",
    });
    expect(scaffolds).toEqual([
      { slot: "web", framework: "sveltekit", path: "apps/web", generator: "sv@0.16", port: 5173 },
      {
        slot: "mobile",
        framework: "expo",
        path: "apps/mobile",
        generator: "create-expo-app@4",
        port: 8081,
      },
    ]);
  });
});

describe("plan → manifest", () => {
  const plan = buildPlan({
    name: "my-app",
    targetDir: "/tmp/my-app",
    cliVersion: "0.1.0",
    selections: { web: "next", mobile: "none", api: "none", backend: "convex" },
    options: OPTIONS,
  });

  test("plan captures identity and conventions", () => {
    expect(plan.name).toBe("my-app");
    expect(plan.createdWith).toBe("create-groot@0.1.0");
    expect(plan.conventions.packagesNamespace).toBe(PACKAGES_NAMESPACE);
    expect(plan.scaffolds).toHaveLength(2);
  });

  test("manifest matches the groot.json contract", () => {
    const manifest = planToManifest(plan);
    expect(manifest.$schema).toBe(MANIFEST_SCHEMA_URL);
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.createdWith).toBe("create-groot@0.1.0");
    expect(manifest.scaffolds).toEqual(plan.scaffolds);
    // The manifest must not leak machine-local or run-specific state.
    expect(manifest).not.toHaveProperty("targetDir");
    expect(manifest).not.toHaveProperty("options");
  });

  test("manifest is JSON-round-trippable", () => {
    const manifest = planToManifest(plan);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe("describePlan", () => {
  test("mentions every scaffold, its destination, and its port", () => {
    const plan = buildPlan({
      name: "demo",
      targetDir: "/tmp/demo",
      cliVersion: "0.1.0",
      selections: { web: "next", mobile: "expo", api: "hono", backend: "convex" },
      options: { ...OPTIONS, install: false },
    });
    const text = describePlan(plan);
    expect(text).toContain("Next.js");
    expect(text).toContain("apps/web");
    expect(text).toContain(":3000");
    expect(text).toContain("Expo");
    expect(text).toContain(":8081");
    expect(text).toContain("Hono");
    expect(text).toContain("packages/backend");
    expect(text).toContain("skipping   install");
  });
});
