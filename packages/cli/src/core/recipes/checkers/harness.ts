/**
 * Shared harness for the recipes' process checks (runtime.http, auth.flow,
 * build.bundle). It answers the questions every such check needs answered
 * truthfully before it can claim anything:
 *
 * - which unit, entry, and scripts the contract targets;
 * - whether the unit's declared packages are installed at all — if not, the
 *   check is `blocked` with `bun install` as the next step, never a fake pass
 *   or a confusing crash;
 * - an isolated environment: an ephemeral loopback port, a temporary SQLite
 *   database, and a throwaway BETTER_AUTH_SECRET passed explicitly (explicit
 *   process env beats .env.local in Bun, so the app's own database and secret
 *   are never touched or read);
 * - migrations applied first and confirmed from the database itself
 *   (`__drizzle_migrations` rows vs the journal), not from an exit code alone.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BlueprintApp } from "../../contracts/blueprint.ts";
import type { Evidence } from "../../contracts/evidence.ts";
import { resolveInProject } from "../../fs/paths.ts";
import { ephemeralPort } from "../../ports.ts";
import { runProcess, tail } from "../../process.ts";
import type { CoreContext } from "../../runtime.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";

export interface UnitUnderTest {
  readonly app: BlueprintApp;
  /** Unit path ("." or "apps/api"). */
  readonly path: string;
  /** Absolute unit directory. */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** Every package the unit declares (dependencies + devDependencies). */
  readonly declared: readonly string[];
}

export function staticMethod(tool: string): Evidence["method"] {
  return { kind: "static", tool, command: null };
}

export function isOutcome(value: object): value is CheckOutcome {
  return "status" in value && "method" in value;
}

export function failure(
  tool: string,
  summary: string,
  nextStep: string | null = null,
): CheckOutcome {
  return { status: "fail", summary, method: staticMethod(tool), nextStep };
}

interface Manifest {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/** The app a contract targets, with its manifest facts — or a failing outcome saying why not. */
export function locateUnit(input: CheckInput, tool: string): UnitUnderTest | CheckOutcome {
  const { apps } = input.blueprint;
  const unitPath = input.contract.unit;
  const app =
    apps.find((entry) => entry.path === unitPath) ??
    (unitPath === null && apps.length === 1 ? apps[0] : undefined);
  if (app === undefined) {
    return failure(tool, `no app at ${unitPath ?? "(no unit)"} in groot.json`);
  }
  const dir = app.path === "." ? input.root : resolveInProject(input.root, app.path);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  } catch {
    return failure(tool, `${app.path}/package.json is missing or unparseable`);
  }
  return {
    app,
    path: app.path,
    dir,
    scripts: manifest.scripts ?? {},
    declared: [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ],
  };
}

function installed(root: string, from: string, name: string): boolean {
  let dir = from;
  for (;;) {
    // Hoisted and isolated (symlinked) layouts both surface node_modules/<name>/package.json.
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dir === root || dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

/** Declared packages that are not installed anywhere between the unit and the project root. */
export function missingPackages(root: string, unit: UnitUnderTest): string[] {
  return unit.declared.filter((name) => !installed(root, unit.dir, name));
}

export function blockedOnInstall(
  tool: string,
  unit: UnitUnderTest,
  missing: string[],
): CheckOutcome {
  const shown = missing.slice(0, 6).join(", ") + (missing.length > 6 ? ", …" : "");
  return {
    status: "blocked",
    summary: `${missing.length} package(s) ${unit.path} declares are not installed (${shown})`,
    method: staticMethod(tool),
    reason: "dependencies not installed",
    nextStep: "Run `bun install` at the project root, then re-run groot verify.",
    details: { missing },
  };
}

/** The process environment for a check run (the secret is throwaway and redacted everywhere). */
export interface CheckEnvironment {
  readonly port: number;
  readonly baseUrl: string;
  readonly secret: string;
  readonly databasePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Removes the temporary directory (database included). */
  cleanup(): void;
}

export const CHECK_ENV_NAMES = [
  "PORT",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "NODE_ENV",
] as const;

export function checkEnvironment(ctx: CoreContext): CheckEnvironment {
  const dir = mkdtempSync(join(tmpdir(), "groot-check-"));
  const port = ephemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("base64url");
  const databasePath = join(dir, "app.db");
  return {
    port,
    baseUrl,
    secret,
    databasePath,
    env: {
      ...ctx.env,
      PORT: String(port),
      DATABASE_URL: databasePath,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: "",
      NODE_ENV: "development",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface MigrationReport {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Entries in drizzle/meta/_journal.json (null when unreadable). */
  readonly journalEntries: number | null;
  /** Rows in __drizzle_migrations after the run. */
  readonly applied: number;
  readonly tables: readonly string[];
  readonly log: string;
  /** Why the migration step failed (null = it worked). */
  readonly problem: string | null;
}

function journalEntries(unitDir: string): number | null {
  try {
    const doc = JSON.parse(readFileSync(join(unitDir, "drizzle", "meta", "_journal.json"), "utf8"));
    return Array.isArray(doc?.entries) ? doc.entries.length : null;
  } catch {
    return null;
  }
}

function inspectDatabase(path: string): { applied: number; tables: string[] } {
  if (!existsSync(path)) return { applied: 0, tables: [] };
  const db = new Database(path, { readwrite: true, create: false });
  try {
    const names = (
      db.query("select name from sqlite_master where type = 'table' order by name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    const applied = names.includes("__drizzle_migrations")
      ? (db.query("select count(*) as n from __drizzle_migrations").get() as { n: number }).n
      : 0;
    const tables = names.filter(
      (name) => name !== "__drizzle_migrations" && !name.startsWith("sqlite_"),
    );
    return { applied, tables };
  } finally {
    db.close();
  }
}

const MIGRATE_ARGV = ["bun", "run", "db:migrate"] as const;

/** `bun run db:migrate` against the temporary database, then confirm from the database itself. */
export async function runMigrations(
  ctx: CoreContext,
  unit: UnitUnderTest,
  environment: CheckEnvironment,
): Promise<MigrationReport> {
  const base = { argv: MIGRATE_ARGV, journalEntries: journalEntries(unit.dir) };
  if (unit.scripts["db:migrate"] === undefined) {
    return {
      ...base,
      exitCode: null,
      durationMs: 0,
      applied: 0,
      tables: [],
      log: "",
      problem: `${unit.path} has no db:migrate script (data.drizzle-sqlite adds one)`,
    };
  }
  const result = await runProcess({
    argv: MIGRATE_ARGV,
    cwd: unit.dir,
    env: environment.env,
    timeoutMs: 120_000,
    signal: ctx.signal,
    secrets: [environment.secret],
  });
  const log = `${result.stdout}\n${result.stderr}`;
  const db =
    result.exitCode === 0 ? inspectDatabase(environment.databasePath) : { applied: 0, tables: [] };
  let problem: string | null = null;
  if (result.exitCode !== 0) {
    problem = `bun run db:migrate failed (exit ${result.exitCode ?? result.signal}): ${tail(log, 3)}`;
  } else if (base.journalEntries !== null && db.applied < base.journalEntries) {
    problem = `only ${db.applied} of ${base.journalEntries} journal migrations were applied`;
  }
  return { ...base, exitCode: result.exitCode, durationMs: result.durationMs, ...db, log, problem };
}

/** How the check starts the app: its dev script, else start, else the entry under bun. */
export function startCommand(unit: UnitUnderTest): string[] | null {
  if (unit.scripts.dev !== undefined) return ["bun", "run", "dev"];
  if (unit.scripts.start !== undefined) return ["bun", "run", "start"];
  if (unit.app.entry !== null) return ["bun", unit.app.entry];
  return null;
}
