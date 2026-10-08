/**
 * runtime.http — the app migrates and serves. Migrations run against a fresh
 * temporary database (confirmed from __drizzle_migrations), the unit starts
 * through its own dev/start script on an ephemeral port, and:
 *
 * - GET / must answer without a server error (any non-5xx — the route may not
 *   exist, the server must not be broken);
 * - for the auth capability, GET /api/auth/ok must answer 200, which proves
 *   the auth routes are mounted and Better Auth initialized with the
 *   configured secret and URL.
 */
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import { type LiveResult, type LiveRun, withLiveServer } from "./live.ts";

interface Probe {
  readonly request: string;
  readonly expected: string;
  readonly actual: number | null;
  readonly ok: boolean;
  readonly ms: number;
  readonly error: string | null;
}

const PROBE_TIMEOUT_MS = 15_000;

async function probe(
  run: LiveRun,
  signal: AbortSignal,
  path: string,
  expected: string,
  accept: (status: number) => boolean,
): Promise<Probe> {
  const started = performance.now();
  const request = `GET ${path}`;
  try {
    const response = await fetch(`${run.baseUrl}${path}`, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    });
    await response.arrayBuffer();
    const ms = Math.round(performance.now() - started);
    return {
      request,
      expected,
      actual: response.status,
      ok: accept(response.status),
      ms,
      error: null,
    };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    return { request, expected, actual: null, ok: false, ms, error: message };
  }
}

function describe(probes: readonly Probe[]): string {
  return probes.map((entry) => `${entry.request} → ${entry.actual ?? entry.error}`).join(", ");
}

export async function runtimeHttpCheck(input: CheckInput): Promise<CheckOutcome> {
  return withLiveServer(input, "runtime.http", async (run): Promise<LiveResult> => {
    const signal = input.ctx.signal;
    const probes = [await probe(run, signal, "/", "non-5xx", (status) => status < 500)];
    if (input.contract.capability === "auth") {
      probes.push(await probe(run, signal, "/api/auth/ok", "200", (status) => status === 200));
    }
    const migrated = `${run.migration.applied}/${run.migration.journalEntries ?? "?"} migrations applied to a fresh temporary database`;
    const ok = probes.every((entry) => entry.ok);
    return {
      status: ok ? "pass" : "fail",
      summary: `${migrated}; ${run.argv.join(" ")} served on an ephemeral port (${run.bootMs} ms to ready): ${describe(probes)}`,
      details: { probes },
      nextStep: ok ? null : "See server.log; the failing probe is listed in details.probes.",
    };
  });
}
