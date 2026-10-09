/**
 * planMigrate: the explicit v1 → v2 plan replaces groot.json only while it
 * still has the migrated bytes, writes an offline (unresolved) lock, and is
 * byte-for-byte reproducible; any other registration state is refused.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateV1ToV2 } from "../blueprint/migrate.ts";
import { serializeBlueprint } from "../blueprint/serialize.ts";
import { BlueprintV2, type ManifestV1 } from "../contracts/blueprint.ts";
import { GrootLock } from "../contracts/lock.ts";
import { OperationPlan } from "../contracts/plan.ts";
import { inspect } from "../discovery/index.ts";
import { bunMonorepo, json, V1_MANIFEST, v1Workspace } from "../discovery/test-projects.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { createContext } from "../runtime.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { planMigrate } from "./migrate.ts";

const TIMEOUT = 60_000;
const NOW = new Date("2026-10-08T12:00:00.000Z");

function contents(plan: OperationPlan): Record<string, string> {
  return Object.fromEntries(
    plan.actions.map((action) => {
      if (action.type !== "file.write") throw new Error(`unexpected ${action.type}`);
      return [action.path, action.content];
    }),
  );
}

async function errorOf(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
  throw new Error("expected a GrootV2Error");
}

describe("planMigrate — groot v1 workspace (c)", () => {
  test(
    "replaces groot.json (guarded by its v1 sha256) and writes an unresolved lock",
    async () => {
      // Arrange
      const root = v1Workspace();
      const ctx = createContext({ cwd: root });
      const v1Sha = sha256Of(readFileSync(join(root, "groot.json")));

      // Act
      const plan = await planMigrate(ctx, root, { now: NOW });

      // Assert — contract and intent
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      expect(plan.intent).toEqual({ type: "migrate", from: 1, to: 2 });
      expect(plan.project.topology).toBe("monorepo");
      expect(
        plan.actions.map((action) => [action.type, "path" in action ? action.path : null]),
      ).toEqual([
        ["file.write", "groot.json"],
        ["file.write", "groot.lock.json"],
      ]);
      expect(plan.actions[0]).toMatchObject({
        expect: { state: "sha256", sha256: v1Sha },
        classes: ["fs.edit"],
      });
      expect(plan.preconditions).toContainEqual({ type: "manifest", state: "v1", sha256: v1Sha });
      expect(plan.preconditions).toContainEqual({
        type: "path",
        path: "groot.json",
        expect: { state: "sha256", sha256: v1Sha },
        dirty: false,
      });

      // Assert — the migrated document is the pure migration of what is on disk
      const files = contents(plan);
      const observation = await inspect(ctx, root);
      const expected = migrateV1ToV2(V1_MANIFEST as unknown as ManifestV1, observation, NOW);
      expect(files["groot.json"]).toBe(serializeBlueprint(expected));
      const doc = BlueprintV2.parse(JSON.parse(files["groot.json"] ?? "{}"));
      expect(doc.scaffolds).toEqual(V1_MANIFEST.scaffolds as unknown as BlueprintV2["scaffolds"]);
      expect(doc.apps.map((app) => [app.id, app.packageName, app.entry, app.origin])).toEqual([
        ["web", "web", null, "generated"],
        ["api", "api", "src/index.ts", "generated"],
        ["backend", "@repo/backend", null, "generated"],
      ]);

      // Assert — the lock records generators as unresolved (offline migration)
      const lock = GrootLock.parse(JSON.parse(files["groot.lock.json"] ?? "{}"));
      expect(
        lock.generators.map((entry) => [
          entry.package,
          entry.range,
          entry.source,
          entry.version,
          entry.usedBy,
        ]),
      ).toEqual([
        ["create-next-app", "16", "unresolved", null, ["apps/web"]],
        ["create-hono", "0.19", "unresolved", null, ["apps/api"]],
      ]);
      expect(plan.assumptions.join("\n")).toContain("Generator versions stay unresolved");
      expect(plan.recovery.mode).toBe("full");
    },
    TIMEOUT,
  );

  test(
    "byte-identical output (and plan fingerprint) across two runs with the same clock",
    async () => {
      // Arrange
      const root = v1Workspace();
      const ctx = createContext({ cwd: root });

      // Act
      const first = await planMigrate(ctx, ".", { now: NOW });
      const second = await planMigrate(ctx, ".", { now: NOW });

      // Assert
      expect(contents(second)).toEqual(contents(first));
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.planId).not.toBe(first.planId);
    },
    TIMEOUT,
  );

  test(
    "a groot.json edited after planning no longer matches the plan's precondition",
    async () => {
      // Arrange
      const root = v1Workspace();
      const ctx = createContext({ cwd: root });
      const plan = await planMigrate(ctx, ".", { now: NOW });

      // Act
      writeFileSync(
        join(root, "groot.json"),
        json({ ...V1_MANIFEST, createdWith: "create-groot@1.10.1" }),
      );
      const replanned = await planMigrate(ctx, ".", { now: NOW });

      // Assert
      const guard = (candidate: OperationPlan) =>
        candidate.preconditions.find((entry) => entry.type === "manifest");
      expect(sha256Of(readFileSync(join(root, "groot.json")))).not.toBe(guard(plan)?.sha256);
      expect(guard(replanned)?.sha256).toBe(sha256Of(readFileSync(join(root, "groot.json"))));
    },
    TIMEOUT,
  );
});

describe("planMigrate — refusals explain the registration state", () => {
  test.each([
    ["unregistered", () => bunMonorepo(), "GROOT_E_USAGE", "nothing to migrate"],
    [
      "already version 2",
      () => bunMonorepo({ "groot.json": serializeBlueprint(blueprintFixture()) }),
      "GROOT_E_USAGE",
      "already has a version 2",
    ],
    [
      "invalid",
      () => bunMonorepo({ "groot.json": "{ broken" }),
      "GROOT_E_INVALID_DOCUMENT",
      "not valid JSON",
    ],
    [
      "version 3",
      () => bunMonorepo({ "groot.json": json({ version: 3 }) }),
      "GROOT_E_UNSUPPORTED_SCHEMA",
      "declares version 3",
    ],
  ])(
    "%s → %s (exit 2) with one next step",
    async (_label, build, id, phrase) => {
      // Arrange
      const root = build();

      // Act
      const error = await errorOf(planMigrate(createContext({ cwd: root }), "."));

      // Assert
      expect(error.id as string).toBe(id);
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(phrase);
      expect(error.message).not.toContain(".).");
      expect(error.hint).not.toBeNull();
    },
    TIMEOUT,
  );
});
