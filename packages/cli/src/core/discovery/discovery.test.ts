/**
 * Discovery over real temporary projects: custom single-app layouts, bun
 * monorepos, pnpm workspaces, native-only roots, symlinks leaving the
 * project, package-manager contradictions, and managed-region states. Every
 * observation is validated against the ProjectObservation contract, and no
 * env value may ever appear in one.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectObservation } from "../contracts/project.ts";
import { createContext } from "../runtime.ts";
import { inspect } from "./index.ts";
import {
  bunMonorepo,
  cargoOnly,
  customHonoApp,
  json,
  makeProject,
  managedRegionsProject,
  monorepoWithOutsideSymlinks,
  packageManagerContradiction,
  pnpmWorkspace,
  pythonOnly,
  SECRET_VALUES,
  v1Workspace,
} from "./test-projects.ts";

const TIMEOUT = 60_000;
const POSIX = process.platform !== "win32";
/** chmod 000 makes a file unreadable only for a non-root user. */
const CAN_REVOKE_READ = POSIX && process.getuid?.() !== 0;

async function observe(root: string): Promise<ProjectObservation> {
  const observation = await inspect(createContext({ cwd: root }), ".");
  // (j) every observation satisfies its published contract
  expect(ProjectObservation.safeParse(observation).success).toBe(true);
  return observation;
}

function unit(observation: ProjectObservation, path: string) {
  const found = observation.units.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`no unit at ${path}`);
  return found;
}

describe("single-app Bun + Hono with a custom layout (a)", () => {
  test(
    "certified, entry/port/env names found, values never reported, dirty paths listed",
    async () => {
      // Arrange
      const root = await customHonoApp();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.root).toBe(root);
      expect(observation.support).toEqual({ level: "certified", reasons: [], nextStep: null });
      expect(observation.topology.value).toBe("single");
      expect(observation.packageManager).toMatchObject({ value: "bun", confidence: "certain" });
      expect(observation.name.value).toBe("acme-edge");
      expect(observation.units).toHaveLength(1);
      const app = unit(observation, ".");
      expect(app.kind).toMatchObject({ value: "api", confidence: "high" });
      expect(app.framework.value).toEqual({ id: "hono", version: "^4.6.0" });
      expect(app.runtime.value).toBe("bun");
      expect(app.language).toBe("typescript");
      expect(app.entry).toMatchObject({
        value: "server/main.ts",
        source: "package.json#scripts.dev",
        confidence: "high",
      });
      expect(app.ports.map((port) => [port.value, port.method, port.confidence])).toEqual([
        [4310, "source-scan", "medium"],
      ]);
      expect(app.ports[0]?.fingerprint).toMatch(/^sha256:/);
      expect(app.envFiles).toEqual([".env.local"]);
      expect(app.envVariables).toEqual([
        { name: "API_SECRET", file: ".env.local", publicPrefix: false },
        { name: "DATABASE_URL", file: ".env.local", publicPrefix: false },
        { name: "PUBLIC_SITE_URL", file: ".env.local", publicPrefix: true },
      ]);
      const serialized = JSON.stringify(observation);
      for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("db.internal");
      expect(observation.git).toMatchObject({
        vcs: "git",
        branch: "main",
        dirty: true,
        staged: ["README.md"],
        unstaged: ["server/routes.ts"],
        untracked: ["scratch.txt"],
      });
      expect(observation.agentFiles.map((file) => [file.path, file.tool])).toEqual([
        ["AGENTS.md", "agents-md"],
        ["CLAUDE.md", "claude-md"],
      ]);
      expect(observation.registration.status).toBe("unregistered");
      expect(observation.toolchains.map((tool) => tool.id)).toEqual(["bun", "node", "git"]);
      expect(observation.toolchains[0]?.requiredBy).toEqual([".", "groot"]);
    },
    TIMEOUT,
  );
});

describe("bun monorepo (b)", () => {
  test(
    "units, kinds, frameworks, ports, capabilities, and the nested AGENTS.md",
    async () => {
      // Arrange
      const root = bunMonorepo();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.topology.value).toBe("monorepo");
      expect(observation.workspaces.value).toEqual(["apps/*", "packages/*"]);
      expect(observation.units.map((entry) => [entry.path, entry.kind.value])).toEqual([
        ["apps/api", "api"],
        ["apps/web", "web"],
        ["packages/typescript-config", "config"],
        ["packages/ui", "library"],
      ]);
      expect(unit(observation, "apps/web").framework.value).toEqual({
        id: "next",
        version: "^16.0.0",
      });
      expect(unit(observation, "apps/web").runtime.value).toBe("node");
      expect(unit(observation, "apps/web").ports[0]).toMatchObject({
        value: 3000,
        confidence: "high",
      });
      expect(unit(observation, "apps/api").runtime.value).toBe("bun");
      expect(unit(observation, "apps/api").entry.value).toBe("src/index.ts");
      expect(unit(observation, "apps/api").ports[0]).toMatchObject({
        value: 3001,
        method: "source-scan",
      });
      expect(unit(observation, "packages/ui").packageName).toBe("@repo/ui");
      expect(observation.agentFiles.map((file) => [file.path, file.tool])).toEqual([
        ["AGENTS.md", "agents-md"],
        ["apps/web/AGENTS.md", "agents-md"],
      ]);
      expect(observation.capabilities.map(({ value }) => value)).toEqual([
        {
          capability: "data",
          provider: "drizzle",
          unit: "apps/api",
          evidence: "declares drizzle-orm@^0.45.3",
        },
      ]);
      expect(observation.support.level).toBe("certified");
    },
    TIMEOUT,
  );
});

describe("registration and blueprint contradictions", () => {
  test(
    "a v1 workspace is registered v1; a scaffold without its package.json is a contradiction",
    async () => {
      // Arrange
      const root = v1Workspace({
        $schema:
          "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json",
        version: 1,
        createdWith: "create-groot@1.10.0",
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
            slot: "mobile",
            framework: "expo",
            path: "apps/mobile",
            generator: "create-expo-app@4",
            port: 8081,
          },
        ],
      });

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.registration).toEqual({
        status: "v1",
        manifestPath: "groot.json",
        version: 1,
        error: null,
      });
      expect(observation.contradictions.map((entry) => entry.explanation)).toEqual([
        "groot.json records scaffold 1 (elysia) at apps/api, but apps/api/package.json declares none of elysia",
        "groot.json records scaffold 2 (expo) at apps/mobile, but apps/mobile/package.json is missing",
      ]);
    },
    TIMEOUT,
  );

  test(
    "a version 3 or malformed groot.json is a registration state, not a crash",
    async () => {
      // Arrange
      const newer = bunMonorepo({ "groot.json": json({ version: 3 }) });
      const broken = bunMonorepo({ "groot.json": "{ not json" });

      // Act
      const [v3, invalid] = [await observe(newer), await observe(broken)];

      // Assert
      expect(v3.registration).toMatchObject({ status: "unsupported-version", version: 3 });
      expect(v3.registration.error).toContain("this CLI reads versions 1 and 2");
      expect(invalid.registration).toMatchObject({ status: "invalid", version: null });
      expect(invalid.registration.error).toContain("not valid JSON");
    },
    TIMEOUT,
  );

  test.skipIf(!POSIX)(
    "an unreadable, self-looping, directory, or dangling groot.json is the state invalid, with a reason and a next step",
    async () => {
      // Arrange
      const unreadable = bunMonorepo({ "groot.json": json({ version: 2 }) });
      chmodSync(join(unreadable, "groot.json"), 0o000);
      const looping = bunMonorepo();
      symlinkSync("groot.json", join(looping, "groot.json"));
      const directory = bunMonorepo();
      mkdirSync(join(directory, "groot.json"));
      const dangling = bunMonorepo();
      symlinkSync("missing.json", join(dangling, "groot.json"));
      const throughFile = bunMonorepo();
      symlinkSync("package.json/x", join(throughFile, "groot.json"));

      // Act
      const observations = {
        looping: await observe(looping),
        directory: await observe(directory),
        dangling: await observe(dangling),
        throughFile: await observe(throughFile),
        ...(CAN_REVOKE_READ ? { unreadable: await observe(unreadable) } : {}),
      };

      // Assert
      const errors = Object.fromEntries(
        Object.entries(observations).map(([label, observation]) => {
          expect(observation.registration).toMatchObject({
            status: "invalid",
            manifestPath: "groot.json",
            version: null,
          });
          expect(observation.support.level).toBe("certified");
          return [label, observation.registration.error ?? ""];
        }),
      );
      expect(errors.looping).toContain("loops");
      expect(errors.looping).toContain("restore it from version control");
      expect(errors.directory).toContain("expected a regular file");
      expect(errors.directory).toContain("restore it from version control");
      expect(errors.dangling).toContain("is a symlink whose target does not exist (ENOENT)");
      expect(errors.throughFile).toContain("is a symlink whose target does not exist (ENOTDIR)");
      expect(errors.throughFile).toContain("check its permissions, owner, and symlinks");
      for (const error of Object.values(errors)) {
        // One next step, after the reason — never the write-side boundary hint.
        expect(error).not.toContain("only writes");
      }
      if (CAN_REVOKE_READ) {
        expect(errors.unreadable).toContain("could not be read (EACCES)");
        expect(errors.unreadable).toContain("readable");
      }
    },
    TIMEOUT,
  );
});

describe("projects Groot can only inspect", () => {
  test(
    "pnpm workspace (e): inspect-only with an actionable next step",
    async () => {
      // Arrange
      const root = pnpmWorkspace();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.packageManager).toMatchObject({ value: "pnpm", method: "lockfile" });
      expect(observation.topology).toMatchObject({
        value: "monorepo",
        source: "pnpm-workspace.yaml#packages",
      });
      expect(observation.units.map((entry) => entry.path)).toEqual(["apps/web", "packages/utils"]);
      expect(observation.support.level).toBe("inspect-only");
      expect(observation.support.reasons).toEqual([
        "package manager is pnpm — Groot certifies writes to Bun-managed projects only",
      ]);
      expect(observation.support.nextStep).toContain("bun install");
      expect(observation.support.nextStep).toContain("pnpm-lock.yaml");
    },
    TIMEOUT,
  );

  test.each([
    ["Cargo.toml", cargoOnly, "cargo"],
    ["pyproject.toml", pythonOnly, "python3"],
  ])(
    "%s-only root (f): native unit, toolchain probed, inspect-only, no crash",
    async (marker, build, toolchain) => {
      // Arrange
      const root = build();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.topology.value).toBe("unknown");
      expect(observation.units).toHaveLength(1);
      expect(unit(observation, ".").runtime).toMatchObject({ value: "native", source: marker });
      expect(unit(observation, ".").language).toBe("unknown");
      const probe = observation.toolchains.find((tool) => tool.id === toolchain);
      expect(probe?.requiredBy).toEqual(["."]);
      expect(typeof probe?.available).toBe("boolean");
      expect(observation.support.level).toBe("inspect-only");
      expect(observation.support.reasons[0]).toContain("native-only project");
    },
    TIMEOUT,
  );

  test(
    "not a directory → unsupported (missing path and plain file)",
    async () => {
      // Arrange
      const root = makeProject({ "notes.txt": "hello\n" });

      // Act
      const missing = await inspect(createContext({ cwd: root }), "does-not-exist");
      const file = await inspect(createContext({ cwd: root }), "notes.txt");

      // Assert
      expect(missing.support).toMatchObject({
        level: "unsupported",
        reasons: [`${join(root, "does-not-exist")} does not exist`],
      });
      expect(file.support).toMatchObject({
        level: "unsupported",
        reasons: [`${join(root, "notes.txt")} is not a directory`],
      });
      expect(missing.support.nextStep).toContain("groot inspect <dir>");
      expect(ProjectObservation.safeParse(missing).success).toBe(true);
      expect(ProjectObservation.safeParse(file).success).toBe(true);
    },
    TIMEOUT,
  );
});

describe("boundaries and contradictions", () => {
  test(
    "symlinks pointing outside the project are not followed but reported (g)",
    async () => {
      // Arrange
      const { root } = monorepoWithOutsideSymlinks();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.units.map((entry) => entry.path)).not.toContain("packages/external");
      expect(observation.agentFiles.map((file) => file.path)).not.toContain("CLAUDE.md");
      expect(observation.unknowns).toContain(
        "packages/external is a symlink that resolves outside the project — not followed",
      );
      expect(observation.unknowns).toContain(
        "CLAUDE.md is a symlink that resolves outside the project — not followed",
      );
      expect(JSON.stringify(observation)).not.toContain("outside instructions");
    },
    TIMEOUT,
  );

  test(
    "packageManager pnpm next to bun.lock is a contradiction (h)",
    async () => {
      // Arrange
      const root = packageManagerContradiction();

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.packageManager).toMatchObject({ value: "pnpm", confidence: "low" });
      expect(observation.contradictions).toContainEqual({
        topic: "packageManager",
        explanation: "package.json declares packageManager pnpm but bun.lock is present",
        sources: ["package.json", "bun.lock"],
      });
      expect(observation.support.level).toBe("inspect-only");
      expect(observation.support.reasons[0]).toContain("package manager is ambiguous");
    },
    TIMEOUT,
  );

  test(
    "managed regions: intact, hand-edited, and malformed (i)",
    async () => {
      // Arrange
      const root = managedRegionsProject();

      // Act
      const observation = await observe(root);

      // Assert
      const regions = (path: string) =>
        observation.agentFiles.find((file) => file.path === path)?.managedRegions ?? null;
      expect(regions("AGENTS.md")).toMatchObject([{ id: "project-context", intact: true }]);
      expect(regions("CLAUDE.md")).toMatchObject([{ id: "agents-import", intact: false }]);
      expect(regions("apps/api/AGENTS.md")).toEqual([]);
      expect(observation.contradictions).toContainEqual({
        topic: "managed-region",
        explanation:
          'apps/api/AGENTS.md: managed region "project-context" has no matching end marker — groot will not edit this file until the markers are repaired',
        sources: ["apps/api/AGENTS.md"],
      });
    },
    TIMEOUT,
  );

  test(
    "skipped trees are never scanned (node_modules, dist, .claude/worktrees)",
    async () => {
      // Arrange
      const root = bunMonorepo({
        "node_modules/x/AGENTS.md": "dependency notes\n",
        "apps/web/dist/AGENTS.md": "build output\n",
        ".claude/worktrees/wt/AGENTS.md": "another checkout\n",
        "packages/ui/node_modules/y/package.json": json({ name: "y" }),
      });
      writeFileSync(join(root, "apps/web/.env"), "SESSION_SECRET=do-not-leak-me\n");

      // Act
      const observation = await observe(root);

      // Assert
      expect(observation.agentFiles.map((file) => file.path)).toEqual([
        "AGENTS.md",
        "apps/web/AGENTS.md",
      ]);
      expect(unit(observation, "apps/web").envVariables.map((entry) => entry.name)).toEqual([
        "SESSION_SECRET",
      ]);
      expect(JSON.stringify(observation)).not.toContain("do-not-leak-me");
    },
    TIMEOUT,
  );
});
