/**
 * `groot verify` — run verification contracts and record evidence
 * (docs/v2-cli-spec.md#groot-verify). Exit 130 when the run was interrupted
 * (GROOT_E_INTERRUPTED, with the partial report); otherwise exit 5 when a
 * check failed; otherwise exit 7 when a requested check is blocked — one
 * blocked decision per check, naming the missing prerequisite; otherwise 0.
 * Skipped checks never fail a run but are always reported.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { renderVerification } from "../cli/render.ts";
import { type CommandResult, GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { VerificationProfile } from "../core/contracts/common.ts";
import type { BlockedDecision } from "../core/contracts/envelope.ts";
import type { Evidence, VerificationReport } from "../core/contracts/evidence.ts";
import { EXIT_V2, GrootV2Error } from "../core/errors.ts";

function parseProfiles(value: string | undefined): VerificationProfile[] {
  if (value === undefined) return ["structural", "build"];
  const profiles = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (profiles.includes("all")) return ["structural", "build", "runtime", "product-flow"];
  for (const profile of profiles) {
    if (!VerificationProfile.safeParse(profile).success) {
      throw new GrootV2Error("GROOT_E_USAGE", `Unknown verification profile "${profile}".`, {
        hint: "Profiles: structural, build, runtime, product-flow (or all).",
      });
    }
  }
  return profiles as VerificationProfile[];
}

/** A blocked check as the prerequisite (or credential) that resolves it. */
function checkDecision(entry: Evidence): BlockedDecision {
  return {
    id: `verify.${entry.check}`,
    kind: Array.isArray(entry.details.missingCredentials) ? "credential" : "prerequisite",
    question: `${entry.check} is blocked: ${entry.reason ?? entry.summary}`,
    options: [],
    resolveWith: entry.nextStep ?? `groot evidence ${entry.id}`,
  };
}

/** The command result for a report — exit precedence: interrupted 130, failed 5, blocked 7, else 0. */
export function verifyResult(report: VerificationReport): CommandResult {
  const failed = report.evidence.some((entry) => entry.status === "fail");
  const blocked = report.evidence.filter((entry) => entry.status === "blocked").map(checkDecision);
  const common = {
    data: report,
    blocked,
    refs: { evidence: report.evidence.map((entry) => entry.id) },
  };
  if (report.interrupted === true) {
    return {
      ...common,
      ok: false,
      exitCode: EXIT_V2.CANCELLED,
      error: new GrootV2Error(
        "GROOT_E_INTERRUPTED",
        "Verification was interrupted before every check ran; the report is partial.",
        { hint: "Checks marked skipped (cancelled) did not run — run groot verify again." },
      ).toInfo(),
      human: () => {
        console.log(renderVerification(report));
        console.log(`\n${pc.yellow("●")} Interrupted — the cancelled checks did not run.`);
      },
    };
  }
  return {
    ...common,
    ok: !failed && blocked.length === 0,
    exitCode: failed ? EXIT_V2.STITCH : blocked.length > 0 ? EXIT_V2.BLOCKED : EXIT_V2.OK,
    human: () => console.log(renderVerification(report)),
  };
}

export const verify = defineCommand({
  meta: { name: "verify", description: "Run verification checks and record evidence" },
  args: {
    profile: {
      type: "string",
      description:
        "Comma list: structural,build,runtime,product-flow (or all). Default: structural,build",
    },
    capability: {
      type: "string",
      description: "Only this capability's checks (plus project structure)",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("verify", { json: args.json, events: args.events }, async (ctx) => {
      const api = createApi();
      const root = api.projectRoot(ctx.cwd);
      const report = await api.verify(ctx, root, {
        profiles: parseProfiles(args.profile),
        capability: args.capability ?? null,
      });
      return verifyResult(report);
    });
  },
});
