/**
 * The recipe checkers against small stand-in apps (offline, no installs):
 * truthful blocked/fail outcomes, process teardown, temporary-database
 * cleanup, secret redaction in stored artifacts, and a product flow that can
 * never pass against a server that answers "yes" to everything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import type { VerificationContract, VerificationProfile } from "../contracts/common.ts";
import type { Evidence } from "../contracts/evidence.ts";
import { ephemeralPort } from "../ports.ts";
import { createContext } from "../runtime.ts";
import { appFixture, blueprintFixture } from "../test-fixtures.ts";
import { runVerification } from "../verify/engine.ts";
import { CHECK_ENV_NAMES, checkEnvironment } from "./checkers/harness.ts";
import { registerRecipeCheckers } from "./index.ts";
import { materializePlan } from "./testing/apply.ts";
import { planBoth, removeScratchDirs, scratchDir, singleApp } from "./testing/fixtures.ts";
import { lockWith } from "./testing/plan.ts";
import { writeFiles } from "./testing/projects.ts";

registerRecipeCheckers();

const TIMEOUT = 90_000;

afterAll(removeScratchDirs);

function contract(
  checker: string,
  capability: string,
  profile: VerificationProfile,
): VerificationContract {
  return {
    id: `${capability}.${profile}.api`,
    profile,
    description: `${checker} on the fake app`,
    checker,
    capability,
    unit: ".",
    needs: { network: false, processes: true, credentials: [], toolchains: ["bun"] },
  };
}

function blueprintFor(contracts: VerificationContract[], entry = "server.ts"): BlueprintV2 {
  return blueprintFixture({
    project: { name: "fake", topology: "single", packageManager: "bun", origin: "adopted" },
    apps: [appFixture({ id: "api", path: ".", entry })],
    verification: contracts,
  });
}

async function verifyOne(
  root: string,
  check: VerificationContract,
  entry = "server.ts",
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Evidence> {
  const report = await runVerification(createContext({ cwd: root, env }), {
    root,
    blueprint: blueprintFor([check], entry),
    observation: null,
    lock: null,
    profiles: [check.profile],
  });
  return report.evidence[0] as Evidence;
}

/** Records pid/secret/db so the test can prove teardown and redaction from outside. */
function fakeServer(home: number, authOk: number): string {
  return `import { writeFileSync } from "node:fs";
writeFileSync("server-facts.json", JSON.stringify({ pid: process.pid, secret: process.env.BETTER_AUTH_SECRET, db: process.env.DATABASE_URL, url: process.env.BETTER_AUTH_URL, env: process.env.NODE_ENV }));
console.log("booting " + process.env.BETTER_AUTH_SECRET);
Bun.serve({
  port: Number(process.env.PORT),
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("home", { status: ${home} });
    if (pathname === "/api/auth/ok") return Response.json({ ok: ${authOk} === 200 }, { status: ${authOk} });
    return new Response("not found", { status: 404 });
  },
});
`;
}

function fakeMigrate(rows: number): string {
  return `import { Database } from "bun:sqlite";
const db = new Database(process.env.DATABASE_URL, { create: true });
db.run("create table __drizzle_migrations (id integer primary key, hash text, created_at numeric)");
for (let i = 0; i < ${rows}; i++) db.run("insert into __drizzle_migrations (hash, created_at) values ('h', 1)");
db.run("create table todos (id text primary key)");
db.close();
console.log("migrated");
`;
}

function fakeApp(
  options: { home?: number; authOk?: number; rows?: number; server?: string } = {},
): string {
  const root = scratchDir("fake-app");
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "fake-api",
      scripts: { "db:migrate": "bun migrate.ts", dev: "bun server.ts" },
    }),
    "migrate.ts": fakeMigrate(options.rows ?? 1),
    "server.ts": options.server ?? fakeServer(options.home ?? 200, options.authOk ?? 200),
    "drizzle/meta/_journal.json": JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, tag: "0000_x" }],
    }),
  });
  return root;
}

function facts(root: string): {
  pid: number;
  secret: string;
  db: string;
  url: string;
  env: string;
} {
  return JSON.parse(readFileSync(join(root, "server-facts.json"), "utf8"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function artifactText(root: string, evidence: Evidence): string {
  return evidence.artifacts
    .map((artifact) => readFileSync(join(root, artifact.path), "utf8"))
    .join("\n");
}

describe("runtime.http", () => {
  test("declared packages not installed → blocked with `bun install`, nothing started", async () => {
    // Arrange
    const root = fakeApp();
    writeFiles(root, {
      "package.json": JSON.stringify({
        name: "fake-api",
        scripts: { dev: "bun server.ts" },
        dependencies: { "drizzle-orm": "0.45.3" },
      }),
    });
    // Act
    const evidence = await verifyOne(root, contract("runtime.http", "data", "runtime"));
    // Assert
    expect(evidence.status).toBe("blocked");
    expect(evidence.nextStep).toContain("bun install");
    expect(evidence.details).toEqual({ missing: ["drizzle-orm"] });
    expect(existsSync(join(root, "server-facts.json"))).toBe(false);
  });

  test(
    "migrates a temporary database, serves on an ephemeral port, then tears everything down",
    async () => {
      // Arrange
      const root = fakeApp();
      // Act
      const evidence = await verifyOne(root, contract("runtime.http", "data", "runtime"));
      // Assert
      expect(evidence.status).toBe("pass");
      expect(evidence.summary).toContain("1/1 migrations applied to a fresh temporary database");
      expect(evidence.details.probes).toEqual([
        expect.objectContaining({ request: "GET /", expected: "non-5xx", actual: 200, ok: true }),
      ]);
      const seen = facts(root);
      expect(seen.env).toBe("development");
      expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(alive(seen.pid)).toBe(false);
      expect(existsSync(seen.db)).toBe(false);
      expect(evidence.artifacts.map((artifact) => artifact.path.split("/").at(-1))).toEqual([
        "migrate.log",
        "server.log",
      ]);
      expect(artifactText(root, evidence)).not.toContain(seen.secret);
      expect(artifactText(root, evidence)).toContain("booting [REDACTED]");
    },
    TIMEOUT,
  );

  test(
    "a server error on GET / fails the check with the probe recorded",
    async () => {
      // Arrange
      const root = fakeApp({ home: 500 });
      // Act
      const evidence = await verifyOne(root, contract("runtime.http", "data", "runtime"));
      // Assert
      expect(evidence.status).toBe("fail");
      expect(evidence.summary).toContain("GET / → 500");
    },
    TIMEOUT,
  );

  test(
    "for auth, GET /api/auth/ok must answer 200 (the auth routes are mounted)",
    async () => {
      // Arrange
      const unmounted = fakeApp({ authOk: 404 });
      const mounted = fakeApp({ authOk: 200 });
      // Act
      const failing = await verifyOne(unmounted, contract("runtime.http", "auth", "runtime"));
      const passing = await verifyOne(mounted, contract("runtime.http", "auth", "runtime"));
      // Assert
      expect(failing.status).toBe("fail");
      expect(failing.summary).toContain("GET /api/auth/ok → 404");
      expect(passing.status).toBe("pass");
    },
    TIMEOUT,
  );

  test("the check environment pins every port variable Bun reads (BUN_PORT > PORT > NODE_PORT)", () => {
    // Arrange
    const ctx = createContext({
      cwd: tmpdir(),
      env: { BUN_PORT: "41001", PORT: "41002", NODE_PORT: "41003", KEEP: "yes" },
    });
    // Act
    const environment = checkEnvironment(ctx);
    environment.cleanup();
    // Assert
    const port = String(environment.port);
    expect([environment.env.BUN_PORT, environment.env.PORT, environment.env.NODE_PORT]).toEqual([
      port,
      port,
      port,
    ]);
    expect(environment.env.KEEP).toBe("yes");
    expect(CHECK_ENV_NAMES).toEqual(expect.arrayContaining(["BUN_PORT", "PORT", "NODE_PORT"]));
  });

  test(
    "a developer's exported BUN_PORT doesn't move the app off the check's ephemeral port",
    async () => {
      // Arrange — a default-export app: Bun picks BUN_PORT over PORT.
      const root = fakeApp({
        server: `import { writeFileSync } from "node:fs";\nwriteFileSync("server-facts.json", JSON.stringify({ pid: process.pid }));\nexport default { fetch: () => new Response("home") };\n`,
      });
      const env = { ...process.env, BUN_PORT: String(ephemeralPort()) };
      // Act
      const evidence = await verifyOne(
        root,
        contract("runtime.http", "data", "runtime"),
        "server.ts",
        env,
      );
      // Assert
      expect(evidence.status).toBe("pass");
      expect(alive(facts(root).pid)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "migrations that apply fewer entries than the journal lists fail before anything starts",
    async () => {
      // Arrange
      const root = fakeApp({ rows: 0 });
      // Act
      const evidence = await verifyOne(root, contract("runtime.http", "data", "runtime"));
      // Assert
      expect(evidence.status).toBe("fail");
      expect(evidence.summary).toBe("migrations: only 0 of 1 journal migrations were applied");
      expect(existsSync(join(root, "server-facts.json"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("auth.flow", () => {
  test(
    "a server that says yes to everything never passes — every step is judged",
    async () => {
      // Arrange
      const root = fakeApp({
        server: `Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({}) });\n`,
      });
      // Act
      const evidence = await verifyOne(root, contract("auth.flow", "auth", "product-flow"));
      // Assert
      expect(evidence.status).toBe("fail");
      const steps = evidence.details.steps as {
        step: string;
        expected: string;
        actual: number;
        ok: boolean;
      }[];
      expect(steps.map((step) => step.step)).toEqual([
        "a",
        "b",
        "b2",
        "c",
        "c2",
        "d",
        "e1",
        "e2",
        "e3",
        "e4",
        "f1",
        "f2",
        "f3",
        "o1",
        "o2",
        "o3",
        "o4",
        "g1",
        "g2",
        "g3",
        "g4",
        "h1",
        "h2",
        "i",
        "j1",
        "j2",
      ]);
      expect(steps[0]).toMatchObject({ step: "a", expected: "401", actual: 200, ok: false });
      // CSRF: a cookie-bearing POST without Origin must be refused, and must not sign bob out.
      expect(steps.find((step) => step.step === "g3")).toMatchObject({
        expected: "403",
        actual: 200,
        ok: false,
      });
      expect(steps.filter((step) => step.ok).length).toBeLessThan(26);
      expect(evidence.artifacts.map((artifact) => artifact.path.split("/").at(-1))).toEqual([
        "migrate.log",
        "flow.json",
        "server.log",
      ]);
      expect(evidence.limitations).toContain(
        "temporary SQLite database — the production database was not exercised",
      );
    },
    TIMEOUT,
  );
});

/** A data-only app: the entry never imports the database modules the data recipe wrote. */
function dataOnlyApp(name: string, overrides: Readonly<Record<string, string>> = {}): string {
  const root = scratchDir(name);
  writeFiles(root, {
    "package.json": JSON.stringify({ name }),
    "src/index.ts": 'export default { fetch: () => new Response("hi") };\n',
    "src/db/schema.ts": "export const todos = { name: 'todos' };\n",
    "src/db/client.ts": 'import * as schema from "./schema";\nexport const db = { schema };\n',
    "src/db/migrate.ts": 'import { db } from "./client";\nconsole.log(Object.keys(db));\n',
    ...overrides,
  });
  return root;
}

describe("build.bundle", () => {
  test(
    "a data-only app: data.build bundles the database modules the entry never imports",
    async () => {
      // Arrange
      const healthy = dataOnlyApp("data-only-ok");
      const brokenImport = dataOnlyApp("data-only-import", {
        "src/db/client.ts": 'import { nope } from "./does-not-exist";\nexport const db = nope;\n',
      });
      const brokenSchema = dataOnlyApp("data-only-schema", {
        "src/db/schema.ts": "export const = ;\n",
      });
      const check = contract("build.bundle", "data", "build");
      // Act
      const passing = await verifyOne(healthy, check, "src/index.ts");
      const importFails = await verifyOne(brokenImport, check, "src/index.ts");
      const schemaFails = await verifyOne(brokenSchema, check, "src/index.ts");
      // Assert
      expect([passing.status, importFails.status, schemaFails.status]).toEqual([
        "pass",
        "fail",
        "fail",
      ]);
      expect(artifactText(brokenImport, importFails)).toContain('"./does-not-exist"');
      expect(artifactText(brokenSchema, schemaFails)).toContain("src/db/schema.ts");
      expect(passing.method.command?.argv).toEqual([
        "bun",
        "build",
        "src/index.ts",
        "src/db/client.ts",
        "src/db/migrate.ts",
        "--target",
        "bun",
        "--outdir",
        "<temporary directory>",
      ]);
      expect(passing.summary).toContain("src/index.ts with src/db/client.ts, src/db/migrate.ts");
    },
    TIMEOUT,
  );

  test(
    "auth.build bundles auth.ts and its route modules as entrypoints of their own",
    async () => {
      // Arrange
      const root = scratchDir("auth-modules");
      writeFiles(root, {
        "package.json": JSON.stringify({ name: "auth-modules" }),
        "src/index.ts": 'export default { fetch: () => new Response("hi") };\n',
        "src/auth.ts": "export const auth = { ok: true };\n",
        "src/http/auth-routes.ts": 'import { auth } from "../auth";\nexport const routes = auth;\n',
        "src/http/notes-routes.ts":
          'import { missing } from "./not-there";\nexport const n = missing;\n',
      });
      // Act
      const evidence = await verifyOne(
        root,
        contract("build.bundle", "auth", "build"),
        "src/index.ts",
      );
      // Assert
      expect(evidence.status).toBe("fail");
      expect(evidence.method.command?.argv.slice(2, 6)).toEqual([
        "src/index.ts",
        "src/auth.ts",
        "src/http/auth-routes.ts",
        "src/http/notes-routes.ts",
      ]);
      expect(artifactText(root, evidence)).toContain('"./not-there"');
    },
    TIMEOUT,
  );

  test(
    "an entry directory starting with '-' is bundled as ./-src/…, never read as a flag",
    async () => {
      // Arrange
      const root = scratchDir("bundle-dash");
      writeFiles(root, {
        "package.json": JSON.stringify({ name: "bundle-dash" }),
        "-src/index.ts": 'export default { fetch: () => new Response("hi") };\n',
        "-src/db/client.ts": "export const db = {};\n",
        "-src/db/migrate.ts": 'import { db } from "./client";\nconsole.log(db);\n',
      });
      // Act
      const evidence = await verifyOne(
        root,
        contract("build.bundle", "data", "build"),
        "-src/index.ts",
      );
      // Assert
      expect(evidence.status).toBe("pass");
      expect(evidence.method.command?.argv.slice(2, 5)).toEqual([
        "./-src/index.ts",
        "./-src/db/client.ts",
        "./-src/db/migrate.ts",
      ]);
    },
    TIMEOUT,
  );

  test(
    "bundles the entry's whole import graph, and fails on an import that doesn't resolve",
    async () => {
      // Arrange
      const ok = scratchDir("bundle-ok");
      writeFiles(ok, {
        "package.json": JSON.stringify({ name: "bundle-ok" }),
        "src/index.ts":
          'import { greet } from "./lib";\nexport default { fetch: () => new Response(greet()) };\n',
        "src/lib.ts": 'export const greet = (): string => "hi";\n',
        "src/db/client.ts": "export const db = {};\n",
        "src/db/migrate.ts": 'import { db } from "./client";\nconsole.log(db);\n',
      });
      const broken = scratchDir("bundle-broken");
      writeFiles(broken, {
        "package.json": JSON.stringify({ name: "bundle-broken" }),
        "src/index.ts": 'import { greet } from "./missing";\nexport default greet;\n',
        "src/db/client.ts": "export const db = {};\n",
        "src/db/migrate.ts": 'import { db } from "./client";\nconsole.log(db);\n',
      });
      const check = contract("build.bundle", "data", "build");
      // Act
      const passing = await verifyOne(ok, check, "src/index.ts");
      const failing = await verifyOne(broken, check, "src/index.ts");
      // Assert
      expect(passing.status).toBe("pass");
      expect(passing.method.command?.argv).toEqual([
        "bun",
        "build",
        "src/index.ts",
        "src/db/client.ts",
        "src/db/migrate.ts",
        "--target",
        "bun",
        "--outdir",
        "<temporary directory>",
      ]);
      expect(failing.status).toBe("fail");
      expect(failing.summary).toContain("bun build failed for src/index.ts");
      // It fails on the entry's own import — every entrypoint exists.
      const log = artifactText(broken, failing);
      expect(log).toContain('"./missing"');
      expect(log).not.toContain("ModuleNotFound");
    },
    TIMEOUT,
  );
});

describe("structural.recipe", () => {
  test(
    "passes on applied wiring; missing files, lost regions, broken journals, and dropped pins fail",
    async () => {
      // Arrange
      const fx = await singleApp();
      const { plan, contributions } = await planBoth(fx);
      await materializePlan(fx.root, plan);
      const lock = lockWith(contributions);
      const run = async (capability: "data" | "auth") =>
        (
          await runVerification(createContext({ cwd: fx.root }), {
            root: fx.root,
            blueprint: {
              ...fx.blueprint,
              verification: contributions.flatMap((c) => c.verification),
            },
            observation: null,
            lock,
            profiles: ["structural"],
            capability,
          })
        ).evidence.find(
          (evidence) => evidence.check === `${capability}.structural.api`,
        ) as Evidence;
      // Act
      const intact = [await run("data"), await run("auth")];
      const entry = join(fx.root, "src/index.ts");
      writeFileSync(
        entry,
        readFileSync(entry, "utf8").replace(
          "app.route('/api/notes', notesRoutes)",
          "app.route('/api/my-notes', notesRoutes)",
        ),
      );
      const edited = await run("auth");
      rmSync(join(fx.root, "src/http/session.ts"));
      rmSync(join(fx.root, "drizzle/0001_auth_init.sql"));
      const broken = await run("auth");
      // Assert
      expect(intact.map((evidence) => evidence.status)).toEqual(["pass", "pass"]);
      expect(intact[0]?.summary).toBe(
        "data.drizzle-sqlite on .: 6 owned artifact(s) present, 2 pinned package(s) declared, migration journal consistent",
      );
      expect(edited.status).toBe("pass");
      expect(edited.summary).toContain("src/index.ts#auth.routes was edited inside its markers");
      expect(broken.status).toBe("fail");
      expect(broken.summary).toContain("src/http/session.ts is missing");
      expect(broken.summary).toContain("migration 0001_auth_init has no SQL file");
    },
    TIMEOUT,
  );
});
