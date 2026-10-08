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

const recordedData = (recipe: string) =>
  blueprintFixture({
    capabilities: [
      {
        id: "data",
        recipe,
        recipeVersion: "1.0.0",
        target: "api",
        options: {},
        addedBy: null,
        addedAt: "2026-10-07T00:00:00.000Z",
      },
    ],
  });

/** Solve `requested` in the given order and in reverse — the outcome must not depend on it. */
function bothOrders(
  requested: SolveInput["requested"],
  input: Omit<SolveInput, "requested">,
): ReturnType<typeof solve>[] {
  return [solve({ ...input, requested }), solve({ ...input, requested: [...requested].reverse() })];
}

const codes = (result: ReturnType<typeof solve>): string[] =>
  result.refusals.map((refusal) => refusal.code);
const keys = (result: ReturnType<typeof solve>): string[] =>
  result.selections.map((selection) => `${selection.capability}@${selection.target}`);

describe("compatibility solver: one solve equals the same steps taken one at a time", () => {
  const TWO_DATA = [
    ...CATALOG,
    fakeRecipe(descriptor({ id: "data.other-sqlite", capability: "data" })),
  ];
  const base = { blueprint: blueprintFixture(), observation, recipes: TWO_DATA };

  test("a requirement's recipe constraint holds when the required capability is requested too", () => {
    for (const result of bothOrders(
      [{ capability: "data", recipe: "data.other-sqlite" }, { capability: "auth" }],
      base,
    )) {
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("missing-requirement");
      expect(result.refusals.find((r) => r.code === "missing-requirement")?.message).toContain(
        "auth.test-auth requires data via data.test-sqlite",
      );
    }
    for (const result of bothOrders(
      [{ capability: "data", recipe: "data.test-sqlite" }, { capability: "auth" }],
      base,
    )) {
      expect(result.ok).toBe(true);
      expect(result.selections.map((s) => [s.capability, s.recipe, s.reason])).toEqual([
        ["data", "data.test-sqlite", "requested"],
        ["auth", "auth.test-auth", "requested"],
      ]);
    }
    // The two-step equivalent was already refused.
    const recorded = solve({
      ...base,
      blueprint: recordedData("data.other-sqlite"),
      requested: [{ capability: "auth" }],
    });
    expect(codes(recorded)).toEqual(["missing-requirement"]);
  });

  test("a request aimed at another app does not override a requirement on this one", () => {
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
    for (const result of bothOrders(
      [
        { capability: "auth", target: "api" },
        { capability: "data", recipe: "data.other-sqlite", target: "admin" },
      ],
      { blueprint, observation: two, recipes: TWO_DATA },
    )) {
      expect(result.ok).toBe(true);
      expect(
        result.selections.map((s) => `${s.capability}@${s.target}=${s.recipe}`).sort(),
      ).toEqual([
        "auth@api=auth.test-auth",
        "data@admin=data.other-sqlite",
        "data@api=data.test-sqlite",
      ]);
    }
  });

  test("declared recipe conflicts between recipes planned together are refused", () => {
    const conflicting = [
      fakeRecipe(descriptor({ id: "data.x", capability: "data" })),
      fakeRecipe(descriptor({ id: "data.y", capability: "data" })),
      fakeRecipe(
        descriptor({
          id: "auth.a",
          capability: "auth",
          requires: [{ capability: "data", recipes: [] }],
          conflicts: [
            {
              capability: "data",
              recipe: "data.y",
              dependency: null,
              reason: "y can't hold sessions",
            },
          ],
        }),
      ),
    ];
    const input = { blueprint: blueprintFixture(), observation, recipes: conflicting };
    for (const result of bothOrders(
      [{ capability: "data", recipe: "data.y" }, { capability: "auth" }],
      input,
    )) {
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["recipe-conflict"]);
      expect(result.refusals[0]?.message).toContain("auth.a conflicts with data.y on api");
    }
    for (const result of bothOrders(
      [{ capability: "data", recipe: "data.x" }, { capability: "auth" }],
      input,
    )) {
      expect(result.ok).toBe(true);
    }
    // A requirement that resolves to the conflicting recipe on its own is refused too…
    const only = solve({
      ...input,
      recipes: conflicting.filter((recipe) => recipe.descriptor.id !== "data.x"),
      requested: [{ capability: "auth" }],
    });
    expect(codes(only)).toEqual(["recipe-conflict"]);
    // …exactly like the two-step equivalent.
    const recorded = solve({
      ...input,
      blueprint: recordedData("data.y"),
      requested: [{ capability: "auth" }],
    });
    expect(codes(recorded)).toEqual(["recipe-conflict"]);
  });

  test("two requests for one capability on one app with different recipes are refused, not dropped", () => {
    for (const result of bothOrders(
      [
        { capability: "data", recipe: "data.other-sqlite" },
        { capability: "data", recipe: "data.test-sqlite" },
      ],
      base,
    )) {
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["recipe-conflict"]);
      expect(result.selections).toHaveLength(1);
    }
    const same = solve({
      ...base,
      requested: [
        { capability: "data", recipe: "data.test-sqlite" },
        { capability: "data", recipe: "data.test-sqlite" },
      ],
    });
    expect(same.ok).toBe(true);
    expect(keys(same)).toEqual(["data@api"]);
  });

  test("re-requesting a recorded capability is already satisfied, even when several recipes fit", () => {
    const result = solve({
      ...base,
      blueprint: recordedData("data.test-sqlite"),
      requested: [{ capability: "data" }],
    });
    expect(result.ok).toBe(true);
    expect(result.selections).toEqual([
      {
        capability: "data",
        recipe: "data.test-sqlite",
        recipeVersion: "1.0.0",
        target: "api",
        reason: "requested",
        alreadySatisfied: true,
      },
    ]);
    // Naming a different recipe for it is still a conflict.
    const other = solve({
      ...base,
      blueprint: recordedData("data.test-sqlite"),
      requested: [{ capability: "data", recipe: "data.other-sqlite" }],
    });
    expect(codes(other)).toEqual(["recipe-conflict"]);
  });

  test("a satisfied requirement is listed once, whichever order requested it", () => {
    for (const result of bothOrders([{ capability: "data" }, { capability: "auth" }], {
      ...base,
      blueprint: recordedData("data.test-sqlite"),
    })) {
      expect(result.ok).toBe(true);
      expect(keys(result)).toEqual(["data@api", "auth@api"]);
      expect(result.selections[0]).toMatchObject({ reason: "requested", alreadySatisfied: true });
    }
  });
});

describe("compatibility solver: recipe choices", () => {
  /** auth.any accepts data from any recipe, and two recipes supply data. */
  const ANY_DATA = [
    fakeRecipe(descriptor({ id: "data.a", capability: "data" })),
    fakeRecipe(descriptor({ id: "data.b", capability: "data" })),
    fakeRecipe(
      descriptor({
        id: "auth.any",
        capability: "auth",
        requires: [{ capability: "data", recipes: [] }],
      }),
    ),
  ];
  const base = { blueprint: blueprintFixture(), observation, recipes: ANY_DATA };

  test("a dependency's recipe choice names the capability to request and what requires it", () => {
    const result = solve({ ...base, requested: [{ capability: "auth" }] });

    expect(result.refusals).toEqual([
      {
        code: "ambiguous-choice",
        message:
          "auth.any requires data (typed persistence) on api, and several recipes supply it (data.a, data.b); choose one by requesting data with --recipe.",
        alternatives: ["--recipe data.a", "--recipe data.b"],
      },
    ]);
  });

  test("a choice reached both as a request and as a requirement is refused once", () => {
    for (const result of bothOrders([{ capability: "data" }, { capability: "auth" }], base)) {
      expect(codes(result)).toEqual(["ambiguous-choice"]);
      expect(result.refusals[0]?.message).toStartWith("Several recipes supply typed persistence");
    }
    // Requesting it with a recipe settles the requirement as well, in either order.
    for (const result of bothOrders(
      [{ capability: "data", recipe: "data.b" }, { capability: "auth" }],
      base,
    )) {
      expect(result.ok).toBe(true);
      expect(result.selections.map((s) => s.recipe)).toEqual(["data.b", "auth.any"]);
    }
  });
});
