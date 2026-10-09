/**
 * The lifecycle runtime.http and auth.flow share: locate the unit → confirm
 * its packages are installed → isolated environment → migrations → start the
 * app through the verification server harness (own process group, ephemeral
 * port) → probe or drive it → stop the whole process group → delete the
 * temporary database. Teardown runs on every path, including failures,
 * crashes inside the probe, and cancellation.
 */
import type { Evidence } from "../../contracts/evidence.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import { type RunningServer, startServer } from "../../verify/server.ts";
import type { ArtifactInput } from "../../verify/store.ts";
import {
  blockedOnInstall,
  CHECK_ENV_NAMES,
  type CheckEnvironment,
  checkEnvironment,
  failure,
  isOutcome,
  locateUnit,
  type MigrationReport,
  missingPackages,
  runMigrations,
  startCommand,
  type UnitUnderTest,
} from "./harness.ts";

export interface LiveRun {
  readonly unit: UnitUnderTest;
  readonly environment: CheckEnvironment;
  readonly migration: MigrationReport;
  readonly baseUrl: string;
  readonly argv: readonly string[];
  readonly bootMs: number;
}

/** What a live check concluded (the harness adds method, logs, and shared limitations). */
export interface LiveResult {
  readonly status: "pass" | "fail";
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly artifacts?: readonly ArtifactInput[];
  readonly limitations?: readonly string[];
  /** Values seen during the run (e.g. session tokens) redacted from every artifact. */
  readonly secrets?: readonly string[];
  readonly nextStep?: string | null;
}

const SERVER_READY_TIMEOUT_MS = 60_000;

function baseLimitations(port: number): string[] {
  return [
    "temporary SQLite database, deleted afterwards — the app's own DATABASE_URL database was not used",
    "throwaway BETTER_AUTH_SECRET — the app's own secret was never read",
    `NODE_ENV=development on 127.0.0.1:${port}: production-only behavior (e.g. Better Auth rate limits, secure cookies over https) was not exercised`,
  ];
}

export function migrationDetails(migration: MigrationReport): Record<string, unknown> {
  return {
    command: migration.argv.join(" "),
    journalEntries: migration.journalEntries,
    applied: migration.applied,
    tables: migration.tables,
    durationMs: migration.durationMs,
  };
}

/**
 * A failure under cancellation is recorded as cancelled — the check was cut
 * short, not proven broken (the engine applies the same rule). A pass, or a
 * check's own blocked/skipped result, stands even if the signal fired as it
 * finished, so a completed check never marks the run interrupted.
 */
export function cancelledOr(input: CheckInput, outcome: CheckOutcome): CheckOutcome {
  if (!input.ctx.signal.aborted || outcome.status !== "fail") return outcome;
  return {
    ...outcome,
    status: "skipped",
    summary: "cancelled while the check was running",
    reason: "cancelled",
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

async function driveThenStop(
  server: RunningServer,
  run: LiveRun,
  body: (run: LiveRun) => Promise<LiveResult>,
): Promise<{ result: LiveResult; log: string }> {
  const result = await body(run).catch(
    (error: unknown): LiveResult => ({
      status: "fail",
      summary: `the check crashed while driving the app: ${error instanceof Error ? error.message : String(error)}`,
      details: {},
    }),
  );
  // body() can't throw past the catch, so the whole process group always goes down here.
  return { result, log: await server.stop() };
}

function migrateLog(migration: MigrationReport): ArtifactInput {
  return { name: "migrate.log", kind: "log", content: migration.log };
}

function migrationFailure(
  tool: string,
  unit: UnitUnderTest,
  migration: MigrationReport,
): CheckOutcome {
  return {
    status: "fail",
    summary: `migrations: ${migration.problem}`,
    method: {
      kind: "command",
      tool,
      command: { argv: [...migration.argv], cwd: unit.path, exitCode: migration.exitCode },
    },
    details: { migration: migrationDetails(migration) },
    artifacts: [migrateLog(migration)],
    nextStep: "Fix the migration error in migrate.log, then re-run groot verify.",
  };
}

/**
 * What to do about a server that never answered. Checks give the app an
 * ephemeral port through PORT; an app that hard-codes its own port either
 * fails to bind it (the log names it) or listens where the check never looks.
 */
export function startFailureNextStep(log: string, port: number): string {
  const named = [...log.matchAll(/(?:port|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)\s*(\d{2,5})\b/gi)]
    .map((match) => Number(match[1]))
    .find((value) => value !== port);
  if (named !== undefined) {
    return `The app used port ${named}, not the PORT=${port} the check gave it. Make the server read PORT with its own port as the default (e.g. \`port: Number(process.env.PORT ?? ${named})\`), then run \`groot verify\` again.`;
  }
  return `The app did not answer on PORT=${port} within the check's timeout. Make sure the server reads process.env.PORT (checks run on ephemeral ports) and starts without errors — see server.log.`;
}

function startFailure(
  method: Evidence["method"],
  migration: MigrationReport,
  error: unknown,
  port: number,
): CheckOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "fail",
    summary: `the server did not start: ${firstLine(message)}`,
    method,
    details: { command: method.command?.argv, port, migration: migrationDetails(migration) },
    artifacts: [migrateLog(migration), { name: "server.log", kind: "log", content: message }],
    nextStep: startFailureNextStep(message, port),
  };
}

function liveOutcome(
  method: Evidence["method"],
  run: LiveRun,
  driven: { result: LiveResult; log: string },
): CheckOutcome {
  const { result, log } = driven;
  return {
    status: result.status,
    summary: result.summary,
    method,
    details: {
      command: run.argv,
      port: run.environment.port,
      env: [...CHECK_ENV_NAMES],
      migration: migrationDetails(run.migration),
      bootMs: run.bootMs,
      ...result.details,
    },
    artifacts: [
      migrateLog(run.migration),
      ...(result.artifacts ?? []),
      { name: "server.log", kind: "log", content: log },
    ],
    limitations: [...baseLimitations(run.environment.port), ...(result.limitations ?? [])],
    secrets: [run.environment.secret, ...(result.secrets ?? [])],
    nextStep: result.nextStep ?? null,
  };
}

async function runLive(
  input: CheckInput,
  tool: string,
  unit: UnitUnderTest,
  environment: CheckEnvironment,
  argv: string[],
  body: (run: LiveRun) => Promise<LiveResult>,
): Promise<CheckOutcome> {
  const method: Evidence["method"] = {
    kind: "http",
    tool,
    command: { argv, cwd: unit.path, exitCode: null },
  };
  // Every outcome is redacted with the throwaway secret, including the failure paths.
  const secrets = [environment.secret];
  const migration = await runMigrations(input.ctx, unit, environment);
  if (migration.problem !== null) {
    return cancelledOr(input, { ...migrationFailure(tool, unit, migration), secrets });
  }
  const started = performance.now();
  let server: RunningServer;
  try {
    server = await startServer({
      argv,
      cwd: unit.dir,
      env: environment.env,
      port: environment.port,
      readyPath: "/",
      readyTimeoutMs: SERVER_READY_TIMEOUT_MS,
      secrets,
      signal: input.ctx.signal,
    });
  } catch (error) {
    return cancelledOr(input, {
      ...startFailure(method, migration, error, environment.port),
      secrets,
    });
  }
  const bootMs = Math.round(performance.now() - started);
  const run: LiveRun = { unit, environment, migration, baseUrl: server.baseUrl, argv, bootMs };
  return cancelledOr(input, liveOutcome(method, run, await driveThenStop(server, run, body)));
}

/** Run `body` against the unit's live server; every precondition failure is reported, never hidden. */
export async function withLiveServer(
  input: CheckInput,
  tool: string,
  body: (run: LiveRun) => Promise<LiveResult>,
): Promise<CheckOutcome> {
  const unit = locateUnit(input, tool);
  if (isOutcome(unit)) return unit;
  const missing = missingPackages(input.root, unit);
  if (missing.length > 0) return blockedOnInstall(tool, unit, missing);
  const argv = startCommand(unit);
  if (argv === null) {
    return failure(tool, `${unit.path} has no dev or start script and no recorded entry to run`);
  }
  const environment = checkEnvironment(input.ctx);
  try {
    return await runLive(input, tool, unit, environment, argv, body);
  } finally {
    environment.cleanup();
  }
}
