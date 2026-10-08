/**
 * The recipe checkers against small stand-in apps (offline, no installs):
 * truthful blocked/fail outcomes, process teardown, temporary-database
 * cleanup, secret redaction in stored artifacts, and a product flow that can
 * never pass against a server that answers "yes" to everything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import type { VerificationContract, VerificationProfile } from "../contracts/common.ts";
import type { Evidence } from "../contracts/evidence.ts";
import { createContext } from "../runtime.ts";
import { appFixture, blueprintFixture } from "../test-fixtures.ts";
import { runVerification } from "../verify/engine.ts";
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
): Promise<Evidence> {
  const report = await runVerification(createContext({ cwd: root }), {
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
      expect(steps).toHaveLength(24);
      expect(steps[0]).toMatchObject({ step: "a", expected: "401", actual: 200, ok: false });
      expect(steps.filter((step) => step.ok).length).toBeLessThan(24);
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

describe("build.bundle", () => {
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
      });
      const broken = scratchDir("bundle-broken");
      writeFiles(broken, {
        "package.json": JSON.stringify({ name: "bundle-broken" }),
        "src/index.ts": 'import { greet } from "./missing";\nexport default greet;\n',
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
        "--target",
        "bun",
        "--outdir",
        "<temporary directory>",
      ]);
      expect(failing.status).toBe("fail");
      expect(failing.summary).toContain("bun build failed for src/index.ts");
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
