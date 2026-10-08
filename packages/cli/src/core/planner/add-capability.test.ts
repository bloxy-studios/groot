import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRequest } from "../capabilities/solver.ts";
import type { RecipeDescriptor } from "../contracts/capability.ts";
import { schemaUrl } from "../contracts/common.ts";
import { GrootLock } from "../contracts/lock.ts";
import { OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import type { Recipe, RecipePlanInput } from "../recipes/types.ts";
import { createContext } from "../runtime.ts";
import { appFixture, blueprintFixture, observationFixture, unitFixture } from "../test-fixtures.ts";
import { planAddCapability } from "./add-capability.ts";

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

/** A recipe that writes one file, adds one dependency, and asks for a post-install step. */
function fakeRecipe(desc: RecipeDescriptor, file: string, dependency: [string, string]): Recipe {
  return {
    descriptor: desc,
    compatibility: () => [],
    async plan(input: RecipePlanInput) {
      const appDir = input.target.app.path;
      await input.builder.writeFile({
        path: `${appDir}/src/${file}`,
        content: `// ${desc.id}\n`,
        description: `create ${file}`,
      });
      const pkg = `${appDir}/package.json`;
      input.builder.add({
        type: "deps.add",
        unit: appDir,
        changes: [
          { unit: appDir, package: dependency[0], from: null, to: dependency[1], dev: false },
        ],
        expect: await input.builder.expectationFor(pkg),
        description: `add ${dependency[0]}@${dependency[1]}`,
        classes: ["deps.change"],
        reversible: true,
        compensation: "restore package.json",
      });
      return {
        capability: {
          id: desc.capability,
          recipe: desc.id,
          recipeVersion: desc.version,
          target: input.target.app.id,
          options: {},
          addedBy: input.builder.planId,
          addedAt: input.builder.createdAt,
        },
        env: [],
        verification: [],
        lock: {
          capability: desc.capability,
          recipe: desc.id,
          recipeVersion: desc.version,
          target: input.target.app.id,
          appliedBy: input.builder.planId,
          plannedAt: input.builder.createdAt,
          dependencies: { [dependency[0]]: dependency[1] },
          artifacts: [
            {
              path: `${appDir}/src/${file}`,
              ownership: "file",
              parts: [],
              sha256: sha256Of(`// ${desc.id}\n`),
            },
          ],
        },
        decisions: [],
        postInstall: [
          {
            type: "command.run",
            argv: ["bun", "run", `${desc.capability}:setup`],
            cwd: appDir,
            purpose: "codegen",
            network: false,
            idempotent: true,
            timeoutMs: 60_000,
            env: {},
            stdin: null,
            touches: [],
            description: `${desc.capability} post-install`,
            classes: ["command"],
            reversible: false,
            compensation: "none needed (idempotent)",
          },
        ],
      };
    },
  };
}

/** This file's own recipe catalog — injected, so no registry state leaks between test files. */
const CATALOG: Recipe[] = [
  fakeRecipe(descriptor({ id: "data.add-test", capability: "data" }), "db.ts", [
    "drizzle-orm",
    "0.45.3",
  ]),
  fakeRecipe(
    descriptor({
      id: "auth.add-test",
      capability: "auth",
      requires: [{ capability: "data", recipes: ["data.add-test"] }],
      conflicts: [
        {
          capability: null,
          recipe: null,
          dependency: "next-auth",
          reason: "another auth library",
        },
      ],
    }),
    "auth.ts",
    ["better-auth", "1.7.7"],
  ),
];

function project() {
  const root = mkdtempSync(join(tmpdir(), "groot-add-"));
  const blueprint = blueprintFixture();
  const lock = GrootLock.parse({
    $schema: schemaUrl("lock"),
    lockVersion: 1,
    generatedBy: "create-groot@2.0.0",
    generators: [],
    recipes: [],
    context: [],
  });
  const blueprintText = `${JSON.stringify(blueprint, null, 2)}\n`;
  mkdirSync(join(root, "apps/api/src"), { recursive: true });
  writeFileSync(join(root, "groot.json"), blueprintText);
  writeFileSync(join(root, "groot.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(
    join(root, "apps/api/package.json"),
    `${JSON.stringify({ name: "api", dependencies: { hono: "4.13.13" } }, null, 2)}\n`,
  );
  return { root, blueprint, lock, blueprintSha: sha256Of(blueprintText) };
}

const ctx = () => createContext({ cwd: tmpdir() });

describe("add-capability planner", () => {
  test("auth pulls in data first, installs once, then runs post-install steps, then records groot.json + lock", async () => {
    const { root, blueprint, lock, blueprintSha } = project();
    const plan = OperationPlan.parse(
      await planAddCapability(ctx(), {
        recipes: CATALOG,
        root,
        blueprint,
        blueprintSha,
        lock,
        observation: observationFixture([unitFixture({ path: "apps/api" })], root),
        requested: [{ capability: "auth", recipe: "auth.add-test" }],
      }),
    );
    expect(plan.capabilities.selections.map((s) => s.recipe)).toEqual([
      "data.add-test",
      "auth.add-test",
    ]);
    expect(plan.actions.map((action) => action.description)).toEqual([
      "create db.ts",
      "add drizzle-orm@0.45.3",
      "create auth.ts",
      "add better-auth@1.7.7",
      "install 2 dependency change(s) (bun install at the workspace root)",
      "data post-install",
      "auth post-install",
      "record data, auth in groot.json (capabilities, environment contracts, verification, decisions)",
      "record exact recipe versions, dependencies, and owned artifacts in groot.lock.json",
    ]);
    const blueprintEdit = plan.actions.find(
      (action) => action.type === "file.edit" && action.path === "groot.json",
    );
    const recorded = JSON.parse(
      blueprintEdit?.type === "file.edit" ? (blueprintEdit.after?.content ?? "{}") : "{}",
    );
    expect(recorded.capabilities.map((entry: { id: string }) => entry.id)).toEqual([
      "data",
      "auth",
    ]);
    expect(recorded.capabilities[0].addedBy).toBe(plan.planId);
    expect(plan.preconditions).toContainEqual({
      type: "manifest",
      state: "v2",
      sha256: blueprintSha,
    });
    expect(plan.dependencies.map((change) => change.package)).toEqual([
      "drizzle-orm",
      "better-auth",
    ]);
    expect(plan.requiredClasses).toContain("install");
  });

  test("an already-present capability plans nothing", async () => {
    const { root, lock } = project();
    const blueprint = blueprintFixture({
      capabilities: [
        {
          id: "data",
          recipe: "data.add-test",
          recipeVersion: "1.0.0",
          target: "api",
          options: {},
          addedBy: null,
          addedAt: "2026-10-07T00:00:00.000Z",
        },
      ],
    });
    const plan = await planAddCapability(ctx(), {
      recipes: CATALOG,
      root,
      blueprint,
      blueprintSha: sha256Of("x"),
      lock,
      observation: observationFixture([unitFixture({ path: "apps/api" })], root),
      requested: [{ capability: "data", recipe: "data.add-test" }],
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary).toContain("already present");
  });

  test("refusals happen at planning time with stable error ids", async () => {
    const { root, blueprint, lock, blueprintSha } = project();
    const base = { root, blueprint, blueprintSha, lock };
    const unknown = planAddCapability(ctx(), {
      recipes: CATALOG,
      ...base,
      observation: observationFixture([unitFixture({ path: "apps/api" })], root),
      requested: [{ capability: "billing" }],
    });
    await expect(unknown).rejects.toMatchObject({ id: "GROOT_E_UNKNOWN_CAPABILITY" });
    const conflicted = planAddCapability(ctx(), {
      recipes: CATALOG,
      ...base,
      observation: observationFixture(
        [unitFixture({ path: "apps/api", dependencies: { hono: "4", "next-auth": "5" } })],
        root,
      ),
      requested: [{ capability: "auth", recipe: "auth.add-test" }],
    });
    await expect(conflicted).rejects.toBeInstanceOf(GrootV2Error);
    await expect(conflicted).rejects.toMatchObject({ id: "GROOT_E_INCOMPATIBLE" });
  });

  test("a missing choice is a blocked decision (exit 7), not an incompatibility", async () => {
    const { root, lock, blueprintSha } = project();
    const twoApps = blueprintFixture({
      apps: [
        appFixture({ id: "api", path: "apps/api" }),
        appFixture({ id: "admin", path: "apps/admin" }),
      ],
    });
    const observation = observationFixture(
      [unitFixture({ path: "apps/api" }), unitFixture({ path: "apps/admin" })],
      root,
    );
    const base = { root, blueprint: twoApps, blueprintSha, lock, observation };

    const target = await planAddCapability(ctx(), {
      ...base,
      recipes: CATALOG,
      requested: [{ capability: "data" }],
    }).catch((error: unknown) => error);
    expect(target).toBeInstanceOf(GrootV2Error);
    expect(target).toMatchObject({ id: "GROOT_E_BLOCKED", exitCode: 7 });
    expect((target as GrootV2Error).blocked).toEqual([
      {
        id: "choice.1",
        kind: "decision",
        question: "Typed persistence fits several apps (api, admin); choose one with --target.",
        options: [
          { id: "api", label: "--target api", effect: expect.any(String), recommended: false },
          { id: "admin", label: "--target admin", effect: expect.any(String), recommended: false },
        ],
        resolveWith: "--target <app>",
      },
    ]);

    const twoRecipes = [
      ...CATALOG,
      fakeRecipe(descriptor({ id: "data.other-test", capability: "data" }), "other.ts", [
        "kysely",
        "0.28.0",
      ]),
    ];
    const recipe = await planAddCapability(ctx(), {
      ...base,
      recipes: twoRecipes,
      requested: [{ capability: "data", target: "api" }],
    }).catch((error: unknown) => error);
    expect(recipe).toMatchObject({ id: "GROOT_E_BLOCKED", exitCode: 7 });
    expect((recipe as GrootV2Error).blocked[0]).toMatchObject({
      kind: "decision",
      resolveWith: "--recipe <id>",
      options: [{ id: "data.add-test" }, { id: "data.other-test" }],
    });

    // A true incompatibility alongside the choice still refuses as one (exit 2).
    const mixed = await planAddCapability(ctx(), {
      ...base,
      recipes: CATALOG,
      requested: [{ capability: "data" }, { capability: "auth", target: "nowhere" }],
    }).catch((error: unknown) => error);
    expect(mixed).toMatchObject({ id: "GROOT_E_INCOMPATIBLE", exitCode: 2 });
  });

  test("a recipe choice names its capability, and resolveWith is a command the CLI can follow", async () => {
    // Arrange — auth.any-data takes data from any recipe, and two recipes supply data.
    const { root, blueprint, lock, blueprintSha } = project();
    const anyData = [
      CATALOG[0] as Recipe,
      fakeRecipe(descriptor({ id: "data.other-test", capability: "data" }), "other.ts", [
        "kysely",
        "0.28.0",
      ]),
      fakeRecipe(
        descriptor({
          id: "auth.any-data",
          capability: "auth",
          requires: [{ capability: "data", recipes: [] }],
        }),
        "auth.ts",
        ["better-auth", "1.7.7"],
      ),
    ];
    const base = {
      root,
      blueprint,
      blueprintSha,
      lock,
      recipes: anyData,
      observation: observationFixture([unitFixture({ path: "apps/api" })], root),
    };
    const blockedOn = async (requested: CapabilityRequest[]): Promise<GrootV2Error> => {
      const error = await planAddCapability(ctx(), { ...base, requested }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ id: "GROOT_E_BLOCKED", exitCode: 7 });
      return error as GrootV2Error;
    };
    const resolution = async (requested: CapabilityRequest[]): Promise<string[]> =>
      (await blockedOn(requested)).blocked.map((decision) => decision.resolveWith);

    // Act — `groot plan add auth`: the CLI would give --recipe to auth, so data is named first.
    const dependency = await blockedOn([{ capability: "auth" }]);

    // Assert
    expect(dependency.blocked).toEqual([
      {
        id: "choice.1",
        kind: "decision",
        question:
          "auth.any-data requires data (typed persistence) on api, and several recipes supply it (data.add-test, data.other-test); choose one by requesting data with --recipe.",
        options: [
          {
            id: "data.add-test",
            label: "--recipe data.add-test",
            effect: "plan data with data.add-test",
            recommended: false,
          },
          {
            id: "data.other-test",
            label: "--recipe data.other-test",
            effect: "plan data with data.other-test",
            recommended: false,
          },
        ],
        resolveWith: "groot plan add data,auth --recipe <id>",
      },
    ]);
    expect(dependency.hint).toBe("groot plan add data,auth --recipe <id>");
    // Following it — `groot plan add data,auth --recipe data.other-test` — plans both.
    const followed = await planAddCapability(ctx(), {
      ...base,
      requested: [{ capability: "data", recipe: "data.other-test" }, { capability: "auth" }],
    });
    expect(followed.capabilities.selections.map((selection) => selection.recipe)).toEqual([
      "data.other-test",
      "auth.any-data",
    ]);
    // Named, but not first: one decision, the same resolution; a shared --target is kept.
    expect(await resolution([{ capability: "auth" }, { capability: "data" }])).toEqual([
      "groot plan add data,auth --recipe <id>",
    ]);
    expect(await resolution([{ capability: "auth", target: "api" }])).toEqual([
      "groot plan add data,auth --target api --recipe <id>",
    ]);
    // Named first: the flag alone.
    expect(await resolution([{ capability: "data" }, { capability: "auth" }])).toEqual([
      "--recipe <id>",
    ]);
    // The one --recipe already belongs to another capability: plan the choice on its own first.
    expect(await resolution([{ capability: "auth", recipe: "auth.any-data" }])).toEqual([
      "groot plan add data --recipe <id>, apply it, then plan auth again",
    ]);
  });
});
