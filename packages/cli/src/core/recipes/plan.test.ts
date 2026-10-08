/**
 * Recipe planning against real temporary projects (offline: no generator, no
 * install): the exact actions for each certified layout, contract-valid plans,
 * human code kept intact, lock records that match what lands on disk, and
 * secrets that never enter a plan.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OperationPlan, type PlannedAction } from "../contracts/plan.ts";
import { envContractViolations } from "../env.ts";
import { sha256Of } from "../fs/hash.ts";
import { joinRel } from "../fs/paths.ts";
import { applyEdit, removeRegion } from "../transforms/index.ts";
import { dataDrizzleSqlite } from "./data/recipe.ts";
import { SCHEMA_TS } from "./data/templates.ts";
import { materializePlan } from "./testing/apply.ts";
import {
  adoptedApp,
  adoptedMain,
  monorepo,
  planBoth,
  removeScratchDirs,
  singleApp,
} from "./testing/fixtures.ts";
import { observeUnit } from "./testing/plan.ts";
import { ADOPTED_AGENTS, CREATE_HONO_INDEX, commitAll } from "./testing/projects.ts";

const TIMEOUT = 60_000;

/**
 * Whether the shared structured edits (core/transforms, not the recipes) keep
 * a file's line endings — the recipes rewrite none of their own.
 */
const TRANSFORMS_KEEP_CRLF = applyEdit(
  "a\r\nb\r\n",
  {
    kind: "managed-region",
    regionId: "probe",
    content: "x",
    commentStyle: "slash",
    placement: "end",
  },
  "probe.ts",
).startsWith("a\r\nb\r\n");

afterAll(removeScratchDirs);

function outline(action: PlannedAction): string {
  switch (action.type) {
    case "file.write":
      return `write ${action.path}`;
    case "file.edit":
      return `edit ${action.path} ${action.edit.kind}${action.after === null ? " deferred" : ""}`;
    case "deps.add":
      return `deps ${action.unit} ${action.changes.map((c) => `${c.package}@${c.to}${c.dev ? ":dev" : ""}`).join(" ")}`;
    case "env.secret":
      return `secret ${action.path} ${action.name}`;
    default:
      return action.type;
  }
}

/** The certified action sequence for an app at `app` whose sources live in `src`. */
function expectedOutline(app: string, src: string, entry: string, gitignore: string): string[] {
  const a = (path: string) => joinRel(app, path);
  const s = (path: string) => joinRel(app, src, path);
  return [
    `write ${s("db/sqlite.ts")}`,
    `write ${s("db/client.ts")}`,
    `write ${s("db/schema.ts")}`,
    `write ${s("db/migrate.ts")}`,
    `write ${a("drizzle.config.ts")}`,
    `write ${a("drizzle/0000_data_init.sql")}`,
    `write ${a("drizzle/meta/0000_snapshot.json")}`,
    `write ${a("drizzle/meta/_journal.json")}`,
    `edit ${a("package.json")} json`,
    `deps ${app} drizzle-orm@0.45.3 drizzle-kit@0.31.11:dev`,
    `edit ${gitignore} lines`,
    `edit ${a(".env.example")} env`,
    `edit ${a(".env.local")} env deferred`,
    `write ${s("auth.ts")}`,
    `write ${s("db/auth-schema.ts")}`,
    `write ${s("db/notes-schema.ts")}`,
    `write ${s("http/cors.ts")}`,
    `write ${s("http/session.ts")}`,
    `write ${s("http/auth-routes.ts")}`,
    `write ${s("http/notes-routes.ts")}`,
    `write ${a("drizzle/0001_auth_init.sql")}`,
    `write ${a("drizzle/meta/0001_snapshot.json")}`,
    `edit ${a("drizzle/meta/_journal.json")} json`,
    `edit ${s("db/schema.ts")} managed-region`,
    `edit ${a(entry)} source-anchor`,
    `edit ${a(entry)} source-anchor`,
    `edit ${a("package.json")} json deferred`,
    `deps ${app} better-auth@1.7.7`,
    `edit ${a(".env.example")} env`,
    `edit ${a(".env.local")} env deferred`,
    `secret ${a(".env.local")} BETTER_AUTH_SECRET`,
  ];
}

describe("data + auth on a create-hono single app", () => {
  test(
    "plans exactly the certified actions, and the plan validates against its contract",
    async () => {
      // Arrange
      const fx = await singleApp();
      // Act
      const { plan } = await planBoth(fx);
      // Assert
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      expect(plan.actions.map(outline)).toEqual(
        expectedOutline(".", "src", "src/index.ts", ".gitignore"),
      );
      expect(plan.requiredClasses).toEqual(["deps.change", "fs.create", "fs.edit"]);
      expect(plan.dependencies).toEqual([
        { unit: ".", package: "drizzle-orm", from: null, to: "0.45.3", dev: false },
        { unit: ".", package: "drizzle-kit", from: null, to: "0.31.11", dev: true },
        { unit: ".", package: "better-auth", from: null, to: "1.7.7", dev: false },
      ]);
    },
    TIMEOUT,
  );

  test(
    "records sound env contracts and per-app verification contracts",
    async () => {
      // Arrange
      const fx = await singleApp();
      // Act
      const { plan } = await planBoth(fx);
      // Assert
      expect(
        plan.environment.map((env) => [env.name, env.sensitivity, env.generate, env.storage]),
      ).toEqual([
        ["DATABASE_URL", "config", "none", ".env.local"],
        ["BETTER_AUTH_SECRET", "secret", "random-secret", ".env.local"],
        ["BETTER_AUTH_URL", "config", "local-url", ".env.local"],
        ["BETTER_AUTH_TRUSTED_ORIGINS", "config", "none", ".env.local"],
      ]);
      expect(envContractViolations(plan.environment)).toEqual([]);
      expect(plan.environment.find((env) => env.name === "BETTER_AUTH_URL")?.example).toBe(
        "http://localhost:3000",
      );
      expect(plan.verification.map((v) => [v.id, v.checker, v.unit])).toEqual([
        ["data.structural.api", "structural.recipe", "."],
        ["data.build.api", "build.bundle", "."],
        ["data.runtime.api", "runtime.http", "."],
        ["auth.structural.api", "structural.recipe", "."],
        ["auth.build.api", "build.bundle", "."],
        ["auth.runtime.api", "runtime.http", "."],
        ["auth.flow.api", "auth.flow", "."],
      ]);
    },
    TIMEOUT,
  );

  test(
    "the secret is generated at apply time and never enters the plan",
    async () => {
      // Arrange
      const fx = await singleApp();
      const { plan } = await planBoth(fx);
      // Act
      const applied = await materializePlan(fx.root, plan);
      // Assert
      const secretStep = plan.actions.find((action) => action.type === "env.secret");
      expect(Object.keys(secretStep ?? {}).sort()).toEqual(
        [
          "classes",
          "compensation",
          "description",
          "generator",
          "id",
          "name",
          "path",
          "reversible",
          "type",
        ].sort(),
      );
      expect(applied.secrets).toHaveLength(1);
      expect(JSON.stringify(plan)).not.toContain(applied.secrets[0] as string);
      const plannedValues = plan.actions.flatMap((action) =>
        action.type === "file.edit" && action.edit.kind === "env"
          ? action.edit.entries
              .filter((entry) => entry.name === "BETTER_AUTH_SECRET")
              .map((entry) => entry.value)
          : [],
      );
      expect(plannedValues).toEqual([""]);
      const previews = plan.actions.flatMap((action) =>
        action.type === "file.edit" && action.after !== null ? [action.after.content] : [],
      );
      for (const content of previews) expect(content).not.toMatch(/^BETTER_AUTH_SECRET=\S/m);
      const envLocal = readFileSync(join(fx.root, ".env.local"), "utf8");
      expect(envLocal).toContain(`BETTER_AUTH_SECRET=${applied.secrets[0]}`);
      expect(envLocal).toContain("DATABASE_URL=./data/app.db");
      expect(envLocal).toContain("BETTER_AUTH_URL=http://localhost:3000");
    },
    TIMEOUT,
  );

  test(
    "applying keeps the human's entry intact: removing Groot's regions restores it byte-for-byte",
    async () => {
      // Arrange
      const fx = await singleApp();
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const entry = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(entry).toContain("import { authRoutes } from './http/auth-routes'\n");
      expect(entry).toContain("app.route('/api/auth', authRoutes)\n");
      const restored = removeRegion(removeRegion(entry, "auth.imports", "e"), "auth.routes", "e");
      expect(restored).toBe(CREATE_HONO_INDEX);
      expect(readFileSync(join(fx.root, "src/db/schema.ts"), "utf8").startsWith(SCHEMA_TS)).toBe(
        true,
      );
      expect(readFileSync(join(fx.root, ".gitignore"), "utf8")).toBe(
        "# deps\nnode_modules/\n\n# Groot: local env files and SQLite data — never commit\n.env.local\n/data/\n",
      );
    },
    TIMEOUT,
  );

  test(
    "lock records match the bytes on disk: owned files by hash, edited files by region",
    async () => {
      // Arrange
      const fx = await singleApp();
      const { plan, contributions } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const [data, auth] = contributions.map((entry) => entry.lock);
      expect(data?.dependencies).toEqual({ "drizzle-orm": "0.45.3", "drizzle-kit": "0.31.11" });
      expect(auth?.dependencies).toEqual({ "better-auth": "1.7.7" });
      for (const lock of [data, auth]) {
        expect(lock?.appliedBy).toBe(plan.planId);
        expect(lock?.plannedAt).toBe(plan.createdAt);
        for (const artifact of lock?.artifacts ?? []) {
          const onDisk = sha256Of(readFileSync(join(fx.root, artifact.path)));
          expect({ path: artifact.path, sha256: artifact.sha256 }).toEqual({
            path: artifact.path,
            sha256: onDisk,
          });
        }
      }
      expect(
        auth?.artifacts.filter((a) => a.ownership === "region").map((a) => [a.path, a.parts]),
      ).toEqual([
        ["src/db/schema.ts", ["auth.schema"]],
        ["src/index.ts", ["auth.imports", "auth.routes"]],
      ]);
      // Starter schema and drizzle-kit's journal are created, never claimed as Groot files.
      const claimed = [...(data?.artifacts ?? []), ...(auth?.artifacts ?? [])]
        .filter((a) => a.ownership === "file")
        .map((a) => a.path);
      expect(claimed).not.toContain("src/db/schema.ts");
      expect(claimed).not.toContain("drizzle/meta/_journal.json");
    },
    TIMEOUT,
  );

  test(
    "blueprint capability records reference the plan",
    async () => {
      // Arrange
      const fx = await singleApp();
      // Act
      const { plan, contributions } = await planBoth(fx);
      // Assert
      expect(contributions.map((c) => c.capability)).toEqual([
        {
          id: "data",
          recipe: "data.drizzle-sqlite",
          recipeVersion: "1.0.0",
          target: "api",
          options: {},
          addedBy: plan.planId,
          addedAt: plan.createdAt,
        },
        {
          id: "auth",
          recipe: "auth.better-auth",
          recipeVersion: "1.0.0",
          target: "api",
          options: {},
          addedBy: plan.planId,
          addedAt: plan.createdAt,
        },
      ]);
      const topics = contributions.flatMap((c) => c.decisions.map((d) => d.topic));
      expect(topics).toEqual([
        "data.store",
        "data.migrations",
        "auth.method",
        "auth.routes",
        "auth.origin",
      ]);
    },
    TIMEOUT,
  );
});

describe("adopted custom layout (server/main.ts, port 4310, dirty tree)", () => {
  test(
    "places modules next to the entry and mounts on the app's own variable in its own style",
    async () => {
      // Arrange
      const fx = await adoptedApp({ dirty: true });
      // Act
      const { plan } = await planBoth(fx);
      await materializePlan(fx.root, plan);
      // Assert
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      expect(plan.actions.map(outline)).toEqual(
        expectedOutline(".", "server", "server/main.ts", ".gitignore"),
      );
      const main = readFileSync(join(fx.root, "server/main.ts"), "utf8");
      expect(main).toContain('import { authRoutes } from "./http/auth-routes";\n');
      expect(main).toContain(
        'api.route("/api/auth", authRoutes);\napi.route("/api/notes", notesRoutes);\n',
      );
      expect(plan.environment.find((env) => env.name === "BETTER_AUTH_URL")?.example).toBe(
        "http://localhost:4310",
      );
      const pkg = JSON.parse(readFileSync(join(fx.root, "package.json"), "utf8"));
      expect(pkg.scripts["db:migrate"]).toBe("bun run server/db/migrate.ts");
      expect(pkg.scripts["auth:generate"]).toContain(
        "--config server/auth.ts --output server/db/auth-schema.ts",
      );
      expect(readFileSync(join(fx.root, "server/db/migrate.ts"), "utf8")).toContain(
        'join(import.meta.dir, "../../drizzle")',
      );
      expect(readFileSync(join(fx.root, "drizzle.config.ts"), "utf8")).toContain(
        'schema: "./server/db/schema.ts"',
      );
    },
    TIMEOUT,
  );

  test(
    "the preview discloses that the routes are registered ahead of the app's later middleware",
    async () => {
      // Arrange — server/main.ts registers `api.use("*", …)` after its declaration.
      const fx = await adoptedApp();
      // Act
      const { plan, contributions } = await planBoth(fx);
      // Assert
      const note = plan.assumptions.find((text) => text.includes("auth.routes block"));
      expect(note).toContain("right after `api = new Hono()` in server/main.ts");
      expect(note).toContain("middleware added later with api.use(…)");
      expect(note).toContain("doesn't run for these routes");
      const decision = contributions[1]?.decisions.find((entry) => entry.topic === "auth.routes");
      expect(decision?.rationale).toContain(note as string);
    },
    TIMEOUT,
  );

  test(
    "human work is preserved: dirty edits flagged (not clobbered), AGENTS.md and scripts untouched",
    async () => {
      // Arrange
      const fx = await adoptedApp({ dirty: true });
      // Act
      const { plan } = await planBoth(fx);
      await materializePlan(fx.root, plan);
      // Assert
      const precondition = plan.preconditions.find(
        (p) => p.type === "path" && p.path === "server/main.ts",
      );
      expect(precondition).toMatchObject({ type: "path", dirty: true });
      const main = readFileSync(join(fx.root, "server/main.ts"), "utf8");
      const restored = removeRegion(removeRegion(main, "auth.imports", "m"), "auth.routes", "m");
      expect(restored).toBe(adoptedMain(true));
      expect(readFileSync(join(fx.root, "AGENTS.md"), "utf8")).toBe(ADOPTED_AGENTS);
      const pkg = JSON.parse(readFileSync(join(fx.root, "package.json"), "utf8"));
      expect(pkg.scripts).toMatchObject({
        dev: "bun --watch server/main.ts",
        start: "bun server/main.ts",
        typecheck: "tsc --noEmit",
      });
      expect(pkg.version).toBe("0.3.0");
    },
    TIMEOUT,
  );
});

describe("a CRLF entry", () => {
  test(
    "anchors, the chain guard, and the placement checks read it; removing Groot's regions gives back the human's lines",
    async () => {
      // Arrange
      const crlf = CREATE_HONO_INDEX.replace(/\n/g, "\r\n");
      const fx = await singleApp((root) => writeFileSync(join(root, "src/index.ts"), crlf));
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert — the line endings themselves are the shared transform's to keep, so compare lines.
      const entry = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      const restored = removeRegion(removeRegion(entry, "auth.imports", "e"), "auth.routes", "e");
      expect(restored.replace(/\r\n/g, "\n")).toBe(CREATE_HONO_INDEX);
      expect(entry.replace(/\r\n/g, "\n")).toContain(
        "const app = new Hono()\n// groot:begin auth.routes",
      );
    },
    TIMEOUT,
  );

  test.skipIf(!TRANSFORMS_KEEP_CRLF)(
    "where the shared transform keeps line endings, every line stays CRLF and removing Groot's regions restores the entry byte-for-byte",
    async () => {
      // Arrange
      const crlf = CREATE_HONO_INDEX.replace(/\n/g, "\r\n");
      const fx = await singleApp((root) => writeFileSync(join(root, "src/index.ts"), crlf));
      const { plan } = await planBoth(fx);
      // Act
      await materializePlan(fx.root, plan);
      // Assert
      const entry = readFileSync(join(fx.root, "src/index.ts"), "utf8");
      expect(entry).not.toMatch(/(?:^|[^\r])\n/);
      expect(removeRegion(removeRegion(entry, "auth.imports", "e"), "auth.routes", "e")).toBe(crlf);
    },
    TIMEOUT,
  );
});

describe("an entry directory with a space (my server/main.ts)", () => {
  test(
    "scripts quote the path and TypeScript literals escape it",
    async () => {
      // Arrange
      const fx = await singleApp((root) => {
        mkdirSync(join(root, "my server"));
        renameSync(join(root, "src/index.ts"), join(root, "my server/main.ts"));
      });
      const app = { ...fx.app, entry: "my server/main.ts" };
      // Act
      const { plan } = await planBoth({ ...fx, app, blueprint: { ...fx.blueprint, apps: [app] } });
      await materializePlan(fx.root, plan);
      // Assert
      const pkg = JSON.parse(readFileSync(join(fx.root, "package.json"), "utf8"));
      expect(pkg.scripts["db:migrate"]).toBe("bun run 'my server/db/migrate.ts'");
      expect(pkg.scripts["auth:generate"]).toContain(
        "--config 'my server/auth.ts' --output 'my server/db/auth-schema.ts'",
      );
      // bun runs scripts through bash/sh/zsh on POSIX: the quoted path stays one word.
      const words = Bun.spawnSync(
        ["sh", "-c", pkg.scripts["db:migrate"].replace(/^bun run/, "printf '[%s]\\n'")],
        { stdout: "pipe" },
      );
      expect(words.stdout.toString()).toBe("[my server/db/migrate.ts]\n");
      expect(readFileSync(join(fx.root, "drizzle.config.ts"), "utf8")).toContain(
        'schema: "./my server/db/schema.ts",',
      );
      expect(readFileSync(join(fx.root, "my server/main.ts"), "utf8")).toContain(
        "app.route('/api/auth', authRoutes)",
      );
    },
    TIMEOUT,
  );
});

describe("an entry directory starting with '-' (-src/main.ts)", () => {
  test(
    "scripts name its paths ./-src/…, so Bun never reads them as flags",
    async () => {
      // Arrange
      const fx = await singleApp((root) => {
        mkdirSync(join(root, "-src"));
        renameSync(join(root, "src/index.ts"), join(root, "-src/main.ts"));
      });
      const app = { ...fx.app, entry: "-src/main.ts" };
      const { plan } = await planBoth({ ...fx, app, blueprint: { ...fx.blueprint, apps: [app] } });
      await materializePlan(fx.root, plan);
      // A stand-in migrate.ts: nothing is installed here, the script line is what's under test.
      writeFileSync(join(fx.root, "-src/db/migrate.ts"), 'console.log("migrate ran");\n');
      // Act
      const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], {
        cwd: fx.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      // Assert
      const pkg = JSON.parse(readFileSync(join(fx.root, "package.json"), "utf8"));
      expect(pkg.scripts["db:migrate"]).toBe("bun run ./-src/db/migrate.ts");
      expect(pkg.scripts["auth:generate"]).toContain(
        "--config ./-src/auth.ts --output ./-src/db/auth-schema.ts",
      );
      expect([migrate.exitCode, migrate.stdout.toString()]).toEqual([0, "migrate ran\n"]);
      expect(readFileSync(join(fx.root, "drizzle.config.ts"), "utf8")).toContain(
        'schema: "./-src/db/schema.ts",',
      );
    },
    TIMEOUT,
  );
});

describe("re-planning an applied project", () => {
  test(
    "data + auth again: nothing to do — starters, the journal, and assigned env values are left alone",
    async () => {
      // Arrange
      const fx = await singleApp();
      await materializePlan(fx.root, (await planBoth(fx)).plan);
      commitAll(fx.root, "add data and auth");
      const applied = { ...fx, observation: await observeUnit(fx.root, fx.app, "single") };
      // Act
      const { plan, contributions } = await planBoth(applied);
      // Assert
      expect(plan.actions.map(outline)).toEqual([]);
      const secret = contributions[1]?.decisions.find((entry) => entry.topic === "auth.secret");
      expect(secret?.value).toBe("kept the existing BETTER_AUTH_SECRET in .env.local");
      // The block may have been moved since: nothing claims it still sits right after the declaration.
      expect(plan.assumptions.some((text) => text.includes("right after"))).toBe(false);
      const routes = contributions[1]?.decisions.find((entry) => entry.topic === "auth.routes");
      expect(routes?.rationale).not.toContain("right after");
      expect(routes?.rationale).toContain("auth.routes block in src/index.ts where it stands");
    },
    TIMEOUT,
  );

  test(
    "data + auth again after the developer's own migration (db:generate appended 0002): nothing to do",
    async () => {
      // Arrange
      const fx = await singleApp();
      await materializePlan(fx.root, (await planBoth(fx)).plan);
      appendFileSync(join(fx.root, "src/db/schema.ts"), "\nexport const owners = 1;\n");
      const journalPath = join(fx.root, "drizzle/meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const entry = {
        idx: 2,
        version: "6",
        when: 1760000000000,
        tag: "0002_owners",
        breakpoints: true,
      };
      writeFileSync(
        journalPath,
        `${JSON.stringify({ ...journal, entries: [...journal.entries, entry] }, null, 2)}\n`,
      );
      writeFileSync(
        join(fx.root, "drizzle/0002_owners.sql"),
        "CREATE TABLE `owners` (`id` text);\n",
      );
      commitAll(fx.root, "add data and auth, then a migration of the developer's own");
      const applied = { ...fx, observation: await observeUnit(fx.root, fx.app, "single") };
      // Act
      const { plan } = await planBoth(applied);
      // Assert
      expect(plan.actions.map(outline)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "data again after data alone, with the starter schema edited by its owner: nothing to do",
    async () => {
      // Arrange
      const fx = await singleApp();
      await materializePlan(fx.root, (await planBoth(fx, [dataDrizzleSqlite])).plan);
      appendFileSync(join(fx.root, "src/db/schema.ts"), "\nexport const owners = 1;\n");
      commitAll(fx.root, "add data, then edit the schema");
      const applied = { ...fx, observation: await observeUnit(fx.root, fx.app, "single") };
      // Act
      const { plan } = await planBoth(applied, [dataDrizzleSqlite]);
      // Assert
      expect(plan.actions.map(outline)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("monorepo apps/api", () => {
  test(
    "plans inside the app, uses the app's own .gitignore, and anchors the data dir to it",
    async () => {
      // Arrange
      const fx = await monorepo();
      // Act
      const { plan } = await planBoth(fx);
      await materializePlan(fx.root, plan);
      // Assert
      expect(OperationPlan.safeParse(plan).success).toBe(true);
      expect(plan.actions.map(outline)).toEqual(
        expectedOutline("apps/api", "src", "src/index.ts", "apps/api/.gitignore"),
      );
      expect(readFileSync(join(fx.root, "apps/api/.gitignore"), "utf8")).toContain(
        "\n.env.local\n/data/\n",
      );
      expect(readFileSync(join(fx.root, ".gitignore"), "utf8")).toBe("node_modules\n");
      expect(
        plan.environment.every(
          (env) => env.consumer === "apps/api" && env.storage === "apps/api/.env.local",
        ),
      ).toBe(true);
      expect(plan.verification.every((v) => v.unit === "apps/api")).toBe(true);
    },
    TIMEOUT,
  );
});
