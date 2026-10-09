/**
 * planAdopt: registering an existing project writes exactly groot.json and
 * groot.lock.json (with exact previews), preserves the custom layout and all
 * uncommitted work, states every inference, and refuses precisely.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blueprintFromObservation } from "../blueprint/adopt.ts";
import { emptyLock } from "../blueprint/lock.ts";
import { serializeBlueprint, serializeLock } from "../blueprint/serialize.ts";
import { BlueprintV2 } from "../contracts/blueprint.ts";
import { GrootLock } from "../contracts/lock.ts";
import { OperationPlan } from "../contracts/plan.ts";
import { inspect } from "../discovery/index.ts";
import {
  BUN_LOCK,
  bunMonorepo,
  customHonoApp,
  json,
  makeProject,
  pnpmWorkspace,
  SECRET_VALUES,
  V1_MANIFEST,
  v1Workspace,
} from "../discovery/test-projects.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { createContext } from "../runtime.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { defaultContracts, registerBuiltInCheckers } from "../verify/checkers.ts";
import { runVerification } from "../verify/engine.ts";
import { planAdopt } from "./adopt.ts";
import { planMigrate } from "./migrate.ts";

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

describe("planAdopt — ports", () => {
  test(
    "a tool's port (database studio, storybook) is never recorded as the app's port",
    async () => {
      // Arrange: the API's port is in its entry; the web app's dev port is next's default.
      const api = makeProject({
        "package.json": json({
          name: "api",
          private: true,
          packageManager: "bun@1.3.14",
          scripts: {
            dev: "bun run --hot src/index.ts",
            "db:studio": "drizzle-kit studio --port 4983",
          },
          dependencies: { hono: "^4.6.0", "drizzle-orm": "^0.45.3" },
          devDependencies: { "@types/bun": "^1.3.14", "drizzle-kit": "^0.31.0" },
        }),
        "bun.lock": BUN_LOCK,
        "src/index.ts":
          'import { Hono } from "hono";\n\nconst app = new Hono();\nexport default { port: 3000, fetch: app.fetch };\n',
      });
      const web = makeProject({
        "package.json": json({
          name: "site",
          private: true,
          packageManager: "bun@1.3.14",
          scripts: { dev: "next dev", build: "next build", storybook: "storybook dev -p 6006" },
          dependencies: { next: "^16.0.0", react: "^19.0.0" },
          devDependencies: { storybook: "^9.0.0" },
        }),
        "bun.lock": BUN_LOCK,
        "app/page.tsx": "export default function Page() {\n  return null;\n}\n",
      });

      // Act
      const [apiPlan, webPlan] = await Promise.all(
        [api, web].map((root) => planAdopt(createContext({ cwd: root }), ".", { now: NOW })),
      );
      const apiUnit = (await inspect(createContext({ cwd: api }), ".")).units[0];

      // Assert
      const appOf = (plan: OperationPlan) =>
        BlueprintV2.parse(JSON.parse(writes(plan)[0]?.content ?? "{}")).apps[0];
      expect(appOf(apiPlan as OperationPlan)?.port).toBe(3000);
      expect(appOf(webPlan as OperationPlan)?.port).toBeNull();
      expect(apiUnit?.ports.map((port) => [port.value, port.confidence, port.source])).toEqual([
        [3000, "medium", "src/index.ts"],
        [4983, "low", "package.json#scripts.db:studio"],
      ]);
      expect((webPlan as OperationPlan).assumptions.join("\n")).not.toContain("6006");
    },
    TIMEOUT,
  );

  test(
    "the app's port comes from the command that runs its entry, not from a tool its dev script starts",
    async () => {
      // Arrange: Hono APIs whose entry declares port 3000 (or none), and a Next app with a codegen step.
      const honoEntry = (port: string) =>
        `import { Hono } from "hono";\n\nconst app = new Hono();\nexport default ${port};\n`;
      const hono = (scripts: Record<string, string>, entry: string) =>
        makeProject({
          "package.json": json({
            name: "api",
            private: true,
            packageManager: "bun@1.3.14",
            scripts,
            dependencies: { hono: "^4.6.0" },
            devDependencies: { "@types/bun": "^1.3.14", "drizzle-kit": "^0.31.0" },
          }),
          "bun.lock": BUN_LOCK,
          "src/index.ts": entry,
        });
      const withPort = honoEntry("{ port: 3000, fetch: app.fetch }");
      const projects = {
        studioViaBunRun: hono(
          {
            dev: "bun run db:studio & bun --hot src/index.ts",
            "db:studio": "drizzle-kit studio --port 4983",
          },
          withPort,
        ),
        studioInDev: hono(
          { dev: "drizzle-kit studio --port 4983 & bun --hot src/index.ts" },
          withPort,
        ),
        unknownSidecar: hono({ dev: "mock-api --port 4010 & bun --hot src/index.ts" }, withPort),
        entryFromDevApi: hono(
          { "dev:api": "PORT=4000 bun --watch src/index.ts" },
          honoEntry("app"),
        ),
        codegenThenNext: makeProject({
          "package.json": json({
            name: "site",
            private: true,
            packageManager: "bun@1.3.14",
            scripts: { dev: "bun scripts/gen.ts && next dev -p 3001" },
            dependencies: { next: "^16.0.0", react: "^19.0.0" },
          }),
          "bun.lock": BUN_LOCK,
          "scripts/gen.ts": 'await Bun.write("src/routes.gen.ts", "export {};\\n");\n',
          "app/page.tsx": "export default function Page() {\n  return null;\n}\n",
        }),
      };

      // Act
      const results = Object.fromEntries(
        await Promise.all(
          Object.entries(projects).map(async ([label, root]) => {
            const ctx = createContext({ cwd: root });
            const plan = await planAdopt(ctx, ".", { now: NOW });
            const unit = (await inspect(ctx, ".")).units[0];
            const recorded = BlueprintV2.parse(JSON.parse(writes(plan)[0]?.content ?? "{}"))
              .apps[0];
            const ports = unit?.ports.map((port) => [port.value, port.confidence, port.source]);
            return [label, { port: recorded?.port, ports }] as const;
          }),
        ),
      );

      // Assert
      expect(results).toEqual({
        studioViaBunRun: {
          port: 3000,
          ports: [
            [3000, "medium", "src/index.ts"],
            [4983, "low", "package.json#scripts.db:studio"],
          ],
        },
        studioInDev: {
          port: 3000,
          ports: [
            [3000, "medium", "src/index.ts"],
            [4983, "low", "package.json#scripts.dev"],
          ],
        },
        unknownSidecar: {
          port: 3000,
          ports: [
            [3000, "medium", "src/index.ts"],
            [4010, "medium", "package.json#scripts.dev"],
          ],
        },
        entryFromDevApi: { port: 4000, ports: [[4000, "high", "package.json#scripts.dev:api"]] },
        codegenThenNext: { port: 3001, ports: [[3001, "medium", "package.json#scripts.dev"]] },
      });
    },
    TIMEOUT,
  );
});

/** Apply the plan's two writes by hand, then run the structural checks `groot verify` runs. */
async function structuralFailuresAfterApply(root: string, plan: OperationPlan): Promise<string[]> {
  for (const action of writes(plan)) writeFileSync(join(root, action.path), action.content);
  const blueprint = BlueprintV2.parse(JSON.parse(readFileSync(join(root, "groot.json"), "utf8")));
  const lock = GrootLock.parse(JSON.parse(readFileSync(join(root, "groot.lock.json"), "utf8")));
  const report = await runVerification(createContext({ cwd: root }), {
    root,
    blueprint,
    observation: null,
    lock,
    profiles: ["structural"],
    extra: defaultContracts(blueprint),
  });
  return report.evidence
    .filter((entry) => entry.status === "fail")
    .map((entry) => entry.check)
    .sort();
}

/** Checks the plan announces as known gaps: noted on the check and stated as an assumption. */
function announcedGaps(plan: OperationPlan): string[] {
  const noted = plan.verification
    .filter((contract) => contract.description.includes("known gap"))
    .map((contract) => contract.id)
    .sort();
  for (const id of noted) expect(plan.assumptions.join("\n")).toContain(`Known gap: ${id} `);
  return noted;
}

describe("planAdopt — structural checks it already knows will fail", () => {
  registerBuiltInCheckers();

  test(
    "a project as discovered passes every structural check its adoption plan declares",
    async () => {
      // Arrange
      const root = bunMonorepo();
      const plan = await planAdopt(createContext({ cwd: root }), ".", { now: NOW });

      // Act
      const failed = await structuralFailuresAfterApply(root, plan);

      // Assert
      expect(announcedGaps(plan)).toEqual([]);
      expect(failed).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a nameless package and a shared dev port: the plan announces exactly the checks that fail",
    async () => {
      // Arrange
      const root = bunMonorepo({
        "apps/web/package.json": json({
          name: "web",
          private: true,
          scripts: { dev: "next dev --port 3000" },
          dependencies: { next: "^16.0.0", react: "^19.0.0" },
        }),
        "apps/admin/package.json": json({
          private: true,
          scripts: { dev: "next dev --port 3000" },
          dependencies: { next: "^16.0.0", react: "^19.0.0" },
        }),
        "apps/admin/app/page.tsx": "export default function Page() {\n  return null;\n}\n",
      });

      // Act
      const plan = await planAdopt(createContext({ cwd: root }), ".", { now: NOW });
      const blueprint = BlueprintV2.parse(JSON.parse(writes(plan)[0]?.content ?? "{}"));
      const failed = await structuralFailuresAfterApply(root, plan);

      // Assert
      expect(announcedGaps(plan)).toEqual(["structural.blueprint", "structural.package.admin"]);
      expect(failed).toEqual(["structural.blueprint", "structural.package.admin"]);
      const assumptions = plan.assumptions.join("\n");
      expect(assumptions).toContain("dev port 3000 is declared by apps/admin and apps/web");
      expect(assumptions).toContain("no package name was observed in apps/admin/package.json");
      const recorded = blueprint.verification.find(
        (contract) => contract.id === "structural.package.admin",
      );
      expect(recorded?.description).toContain("known gap");
      expect(recorded).toEqual(
        plan.verification.find((contract) => contract.id === "structural.package.admin"),
      );
    },
    TIMEOUT,
  );

  test(
    "migration shares the helpers: a scaffold missing on disk is stated, not silently recorded",
    async () => {
      // Arrange
      const root = v1Workspace({
        ...V1_MANIFEST,
        scaffolds: [
          ...V1_MANIFEST.scaffolds,
          {
            slot: "mobile",
            framework: "expo",
            path: "apps/mobile",
            generator: "create-expo-app@4",
            port: 8081,
          },
        ],
      });

      // Act
      const plan = await planMigrate(createContext({ cwd: root }), ".", { now: NOW });

      // Assert
      const assumptions = plan.assumptions.join("\n");
      expect(assumptions).toContain(
        "groot.json records scaffold 3 (expo) at apps/mobile, but apps/mobile/package.json is missing",
      );
      expect(announcedGaps(plan)).toEqual(["structural.package.mobile"]);
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

  test.skipIf(process.platform === "win32")(
    "a groot.json symlink that loops or leads nowhere is refused with the reader's next step — never planned as absent",
    async () => {
      // Arrange
      const looping = bunMonorepo();
      symlinkSync("groot.json", join(looping, "groot.json"));
      const throughFile = bunMonorepo();
      symlinkSync("package.json/x", join(throughFile, "groot.json"));

      // Act
      const loopError = await errorOf(planAdopt(createContext({ cwd: looping }), "."));
      const linkError = await errorOf(planAdopt(createContext({ cwd: throughFile }), "."));

      // Assert
      expect(loopError.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
      expect(linkError.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(linkError.message).toContain("is a symlink whose target does not exist (ENOTDIR)");
      for (const error of [loopError, linkError]) {
        expect(error.hint).toContain("Make groot.json a readable regular file inside the project");
        expect(error.hint).not.toContain("only writes");
      }
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
