/**
 * planAdopt: registering an existing project writes exactly groot.json and
 * groot.lock.json (with exact previews), preserves the custom layout and all
 * uncommitted work, states every inference, and refuses precisely.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blueprintFromObservation } from "../blueprint/adopt.ts";
import { emptyLock } from "../blueprint/lock.ts";
import { serializeBlueprint, serializeLock } from "../blueprint/serialize.ts";
import { BlueprintV2 } from "../contracts/blueprint.ts";
import { OperationPlan } from "../contracts/plan.ts";
import { inspect } from "../discovery/index.ts";
import {
  bunMonorepo,
  customHonoApp,
  json,
  pnpmWorkspace,
  SECRET_VALUES,
  v1Workspace,
} from "../discovery/test-projects.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { createContext } from "../runtime.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { planAdopt } from "./adopt.ts";

const TIMEOUT = 60_000;
const NOW = new Date("2026-10-08T12:00:00.000Z");

async function errorOf(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
  throw new Error("expected a GrootV2Error");
}

function writes(plan: OperationPlan) {
  return plan.actions.map((action) => {
    if (action.type !== "file.write") throw new Error(`unexpected ${action.type}`);
    return action;
  });
}

describe("planAdopt — single app with a custom layout (a)", () => {
  test(
    "writes only groot.json + groot.lock.json with exact previews; layout and dirty work untouched",
    async () => {
      // Arrange
      const root = await customHonoApp();
      const ctx = createContext({ cwd: root });
      const before = readFileSync(join(root, "server/routes.ts"), "utf8");

      // Act
      const plan = await planAdopt(ctx, root, { now: NOW });
      const observation = await inspect(ctx, root);

      // Assert — contract, intent, project
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      expect(plan.intent).toEqual({ type: "adopt" });
      expect(plan.project).toMatchObject({ root, topology: "single" });
      expect(plan.project.revision.dirty).toBe(true);
      expect(plan.requiredClasses).toEqual(["fs.create"]);

      // Assert — exactly two writes, exact previews
      const [manifest, lock] = writes(plan);
      expect(plan.actions).toHaveLength(2);
      expect(manifest).toMatchObject({
        path: "groot.json",
        expect: { state: "absent" },
        ownership: "file",
      });
      expect(lock).toMatchObject({ path: "groot.lock.json", expect: { state: "absent" } });
      expect(manifest?.content).toBe(
        serializeBlueprint(blueprintFromObservation(observation, { now: NOW })),
      );
      expect(manifest?.sha256).toBe(sha256Of(manifest?.content ?? ""));
      expect(lock?.content).toBe(serializeLock(emptyLock()));

      // Assert — the blueprint keeps the custom layout
      const blueprint = BlueprintV2.parse(JSON.parse(manifest?.content ?? "{}"));
      expect(blueprint.apps).toEqual([
        {
          id: "acme-edge",
          path: ".",
          kind: "api",
          framework: "hono",
          packageName: "acme-edge",
          port: 4310,
          origin: "adopted",
          entry: "server/main.ts",
        },
      ]);
      expect(blueprint.project).toEqual({
        name: "acme-edge",
        topology: "single",
        packageManager: "bun",
        origin: "adopted",
      });

      // Assert — preconditions, ownership, assumptions, recovery
      expect(plan.preconditions).toEqual([
        { type: "path", path: "groot.json", expect: { state: "absent" }, dirty: false },
        { type: "path", path: "groot.lock.json", expect: { state: "absent" }, dirty: false },
        { type: "manifest", state: "absent", sha256: null },
      ]);
      expect(plan.ownership.map((rule) => [rule.path, rule.owner])).toEqual([
        ["groot.json", "groot"],
        ["groot.lock.json", "groot"],
        [".", "human"],
      ]);
      const assumptions = plan.assumptions.join("\n");
      expect(assumptions).toContain("README.md, scratch.txt, server/routes.ts");
      expect(assumptions).toContain("port 4310 (medium, source-scan: server/main.ts)");
      expect(assumptions).toContain(".groot/, which ignores itself");
      expect(plan.recovery).toMatchObject({ mode: "full", irreversible: [] });
      expect(plan.verification.map((contract) => contract.id)).toContain(
        "structural.package.acme-edge",
      );

      // Assert — no secrets anywhere, and planning changed nothing on disk
      const text = JSON.stringify(plan);
      for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
      expect(existsSync(join(root, "groot.json"))).toBe(false);
      expect(existsSync(join(root, ".groot"))).toBe(false);
      expect(readFileSync(join(root, "server/routes.ts"), "utf8")).toBe(before);
    },
    TIMEOUT,
  );
});

describe("planAdopt — bun monorepo (b)", () => {
  test(
    "apps from units (config preset excluded); every unit stays human-owned",
    async () => {
      // Arrange
      const root = bunMonorepo();

      // Act
      const plan = await planAdopt(createContext({ cwd: root }), ".", { now: NOW });

      // Assert
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      const blueprint = BlueprintV2.parse(JSON.parse(writes(plan)[0]?.content ?? "{}"));
      expect(
        blueprint.apps.map((app) => [app.id, app.path, app.kind, app.framework, app.port]),
      ).toEqual([
        ["api", "apps/api", "api", "hono", 3001],
        ["web", "apps/web", "web", "next", 3000],
        ["ui", "packages/ui", "library", null, null],
      ]);
      expect(blueprint.conventions.packagesNamespace).toBe("@repo");
      expect(
        plan.ownership.filter((rule) => rule.owner === "human").map((rule) => rule.path),
      ).toEqual(["apps/api", "apps/web", "packages/typescript-config", "packages/ui"]);
    },
    TIMEOUT,
  );
});

describe("planAdopt — refusals", () => {
  test(
    "already registered (v2) → GROOT_E_CONFLICT pointing at groot status",
    async () => {
      // Arrange
      const root = bunMonorepo({ "groot.json": serializeBlueprint(blueprintFixture()) });

      // Act
      const error = await errorOf(planAdopt(createContext({ cwd: root }), "."));

      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.hint).toContain("groot status");
    },
    TIMEOUT,
  );

  test(
    "groot v1 workspace (c) → GROOT_E_MIGRATION_REQUIRED pointing at groot migrate",
    async () => {
      // Arrange
      const root = v1Workspace();

      // Act
      const error = await errorOf(planAdopt(createContext({ cwd: root }), "."));

      // Assert
      expect(error.id).toBe("GROOT_E_MIGRATION_REQUIRED");
      expect(error.hint).toContain("groot migrate");
    },
    TIMEOUT,
  );

  test(
    "unreadable groot.json → GROOT_E_INVALID_DOCUMENT; version 3 → GROOT_E_UNSUPPORTED_SCHEMA",
    async () => {
      // Arrange
      const invalid = bunMonorepo({ "groot.json": "{ broken" });
      const newer = bunMonorepo({ "groot.json": json({ version: 3 }) });

      // Act
      const invalidError = await errorOf(planAdopt(createContext({ cwd: invalid }), "."));
      const newerError = await errorOf(planAdopt(createContext({ cwd: newer }), "."));

      // Assert
      expect(invalidError.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(newerError.id).toBe("GROOT_E_UNSUPPORTED_SCHEMA");
    },
    TIMEOUT,
  );

  test(
    "pnpm workspace (e) → GROOT_E_UNSUPPORTED_PROJECT with reasons and next step",
    async () => {
      // Arrange
      const root = pnpmWorkspace();

      // Act
      const error = await errorOf(planAdopt(createContext({ cwd: root }), "."));

      // Assert
      expect(error.id).toBe("GROOT_E_UNSUPPORTED_PROJECT");
      expect(error.exitCode).toBe(2);
      expect(error.details).toMatchObject({
        level: "inspect-only",
        reasons: ["package manager is pnpm — Groot certifies writes to Bun-managed projects only"],
      });
      expect(String(error.details?.nextStep)).toContain("bun install");
      expect(error.hint).toBe(String(error.details?.nextStep));
    },
    TIMEOUT,
  );

  test(
    "a stray groot.lock.json is never overwritten → GROOT_E_CONFLICT",
    async () => {
      // Arrange
      const root = bunMonorepo({ "groot.lock.json": json({ hand: "written" }) });

      // Act
      const error = await errorOf(planAdopt(createContext({ cwd: root }), "."));

      // Assert
      expect(error.id).toBe("GROOT_E_CONFLICT");
      expect(error.details).toMatchObject({ path: "groot.lock.json", conflict: "file-exists" });
    },
    TIMEOUT,
  );
});
