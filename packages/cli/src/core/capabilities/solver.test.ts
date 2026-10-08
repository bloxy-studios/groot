import { describe, expect, test } from "bun:test";
import type { RecipeDescriptor } from "../contracts/capability.ts";
import type { Recipe } from "../recipes/types.ts";
import { appFixture, blueprintFixture, observationFixture, unitFixture } from "../test-fixtures.ts";
import { type SolveInput, solve } from "./solver.ts";

function descriptor(
  overrides: Partial<RecipeDescriptor> & Pick<RecipeDescriptor, "id" | "capability">,
): RecipeDescriptor {
  return {
    version: "1.0.0",
    title: overrides.id,
    summary: "",
    support: "certified",
    provides: [],
    requires: [],
    conflicts: [],
    targets: {
      kinds: ["api"],
      frameworks: ["hono"],
      runtimes: ["bun"],
      topologies: ["single", "monorepo"],
    },
    dependencies: {},
    devDependencies: {},
    env: [],
    verification: [],
    external: [],
    recovery: { mode: "full", summary: "", irreversible: [], limits: [] },
    certification: null,
    ...overrides,
  };
}

function fakeRecipe(desc: RecipeDescriptor): Recipe {
  return {
    descriptor: desc,
    compatibility: () => [],
    plan: async () => {
      throw new Error("not used by solver tests");
    },
  };
}

const CATALOG: Recipe[] = [
  fakeRecipe(descriptor({ id: "data.test-sqlite", capability: "data" })),
  fakeRecipe(
    descriptor({
      id: "auth.test-auth",
      capability: "auth",
      requires: [{ capability: "data", recipes: ["data.test-sqlite"] }],
      conflicts: [
        {
          capability: null,
          recipe: null,
          dependency: "next-auth",
          reason: "another auth library is already installed",
        },
      ],
    }),
  ),
];

/** Solve against this file's own catalog — no shared registry state between test files. */
const solveWith = (input: Omit<SolveInput, "recipes">) => solve({ ...input, recipes: CATALOG });

const observation = observationFixture([unitFixture({ path: "apps/api" })]);

describe("compatibility solver", () => {
  test("orders requirements first and pins them to the dependent's app", () => {
    const result = solveWith({
      requested: [{ capability: "auth" }],
      blueprint: blueprintFixture(),
      observation,
    });
    expect(result.ok).toBe(true);
    expect(result.selections.map((s) => [s.capability, s.recipe, s.target, s.reason])).toEqual([
      ["data", "data.test-sqlite", "api", "dependency"],
      ["auth", "auth.test-auth", "api", "requested"],
    ]);
  });

  test("an already-recorded requirement is reported as satisfied, not re-applied", () => {
    const blueprint = blueprintFixture({
      capabilities: [
        {
          id: "data",
          recipe: "data.test-sqlite",
          recipeVersion: "1.0.0",
          target: "api",
          options: {},
          addedBy: null,
          addedAt: "2026-10-07T00:00:00.000Z",
        },
      ],
    });
    const result = solveWith({ requested: [{ capability: "auth" }], blueprint, observation });
    expect(result.selections[0]).toMatchObject({ capability: "data", alreadySatisfied: true });
    expect(result.selections[1]).toMatchObject({ capability: "auth", alreadySatisfied: false });
  });

  test("refuses unknown capabilities with the known alternatives", () => {
    const result = solveWith({
      requested: [{ capability: "billing" }],
      blueprint: blueprintFixture(),
      observation,
    });
    expect(result.ok).toBe(false);
    expect(result.refusals[0]?.code).toBe("unknown-capability");
    expect(result.refusals[0]?.alternatives).toEqual(["data", "auth"]);
  });

  test("refuses incompatible targets at planning time with a reason", () => {
    const blueprint = blueprintFixture({
      apps: [appFixture({ id: "web", path: "apps/web", kind: "web", framework: "next" })],
    });
    const result = solveWith({ requested: [{ capability: "auth" }], blueprint, observation });
    expect(result.ok).toBe(false);
    expect(result.refusals[0]?.code).toBe("no-compatible-target");
    expect(result.refusals[0]?.message).toContain("web is a web app");
  });

  test("an observed conflicting dependency blocks the recipe", () => {
    const conflicted = observationFixture([
      unitFixture({ path: "apps/api", dependencies: { hono: "^4", "next-auth": "^5" } }),
    ]);
    const result = solveWith({
      requested: [{ capability: "auth" }],
      blueprint: blueprintFixture(),
      observation: conflicted,
    });
    expect(result.refusals.map((r) => r.code)).toEqual(["dependency-conflict"]);
    expect(result.refusals[0]?.message).toContain("next-auth");
  });

  test("several compatible apps require an explicit --target", () => {
    const blueprint = blueprintFixture({
      apps: [
        appFixture({ id: "api", path: "apps/api" }),
        appFixture({ id: "admin", path: "apps/admin" }),
      ],
    });
    const two = observationFixture([
      unitFixture({ path: "apps/api" }),
      unitFixture({ path: "apps/admin" }),
    ]);
    const ambiguous = solveWith({
      requested: [{ capability: "data" }],
      blueprint,
      observation: two,
    });
    expect(ambiguous.refusals[0]?.alternatives).toEqual(["--target api", "--target admin"]);
    const pinned = solveWith({
      requested: [{ capability: "data", target: "admin" }],
      blueprint,
      observation: two,
    });
    expect(pinned.selections[0]?.target).toBe("admin");
  });

  test("a different recipe already recorded for the capability is a conflict", () => {
    const blueprint = blueprintFixture({
      capabilities: [
        {
          id: "data",
          recipe: "data.other",
          recipeVersion: "1.0.0",
          target: "api",
          options: {},
          addedBy: null,
          addedAt: "2026-10-07T00:00:00.000Z",
        },
      ],
    });
    const result = solveWith({ requested: [{ capability: "data" }], blueprint, observation });
    expect(result.refusals[0]?.code).toBe("recipe-conflict");
  });

  test("two recipes that could supply a capability require an explicit --recipe", () => {
    const catalog = [
      ...CATALOG,
      fakeRecipe(descriptor({ id: "data.other-sqlite", capability: "data" })),
    ];
    const input = { blueprint: blueprintFixture(), observation, recipes: catalog };
    const ambiguous = solve({ ...input, requested: [{ capability: "data" }] });
    expect(ambiguous.refusals[0]?.code).toBe("ambiguous-choice");
    expect(ambiguous.refusals[0]?.alternatives).toEqual([
      "--recipe data.test-sqlite",
      "--recipe data.other-sqlite",
    ]);
    const chosen = solve({
      ...input,
      requested: [{ capability: "data", recipe: "data.other-sqlite" }],
    });
    expect(chosen.selections[0]?.recipe).toBe("data.other-sqlite");
  });
});
