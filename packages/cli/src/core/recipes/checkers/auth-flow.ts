/**
 * auth.flow — the product flow against real wiring: the app's own server,
 * started by its own script, with migrations applied to a fresh temporary
 * database, driven over HTTP through sign-up, sessions, per-user notes,
 * forged and stale credentials, cross-origin and Origin-less (CSRF) requests,
 * sign-out, and sign-in (checkers/flow.ts). Evidence carries the step table; flow.json and the
 * redacted server.log are stored as artifacts.
 */
import { prettyJson } from "../../json.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import { runAuthFlow } from "./flow.ts";
import { type LiveResult, withLiveServer } from "./live.ts";

export const FLOW_LIMITATIONS: readonly string[] = [
  "temporary SQLite database — the production database was not exercised",
  "email verification is off (email + password without requireEmailVerification), so no mail delivery was tested",
  "a single server process on loopback — multi-instance session behavior and TLS were not exercised",
];

export async function authFlowCheck(input: CheckInput): Promise<CheckOutcome> {
  return withLiveServer(input, "auth.flow", async (run): Promise<LiveResult> => {
    const started = performance.now();
    const flow = await runAuthFlow(run.baseUrl, input.ctx.signal);
    const flowMs = Math.round(performance.now() - started);
    const failed = flow.steps.filter((step) => !step.ok);
    const total = flow.steps.length;
    const timings = { migrateMs: run.migration.durationMs, bootMs: run.bootMs, flowMs };
    return {
      status: failed.length === 0 && total > 0 ? "pass" : "fail",
      summary:
        failed.length === 0
          ? `${total}/${total} product-flow steps passed: sign-up/sign-in/sign-out, per-user notes (create 201, invalid 400, cross-user delete 404, owner delete 204), unauthenticated/forged/stale/bearer requests 401, untrusted Origin 403, cookie-bearing POST without Origin 403 (session kept)`
          : `${failed.length} of ${total} product-flow steps failed: ${failed.map((step) => `${step.step} ${step.request} (expected ${step.expected}, got ${step.actual})`).join("; ")}`,
      details: { steps: flow.steps, timings, base: run.baseUrl },
      artifacts: [
        {
          name: "flow.json",
          kind: "json",
          content: prettyJson({ base: run.baseUrl, timings, steps: flow.steps, notes: flow.notes }),
        },
      ],
      limitations: FLOW_LIMITATIONS,
      secrets: flow.secrets,
      nextStep: failed.length === 0 ? null : "See flow.json (per-step notes) and server.log.",
    };
  });
}
