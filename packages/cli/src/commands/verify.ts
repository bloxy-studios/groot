/**
 * `groot verify` — run verification contracts and record evidence
 * (docs/v2-cli-spec.md#groot-verify). Exit 5 when a check failed; otherwise
 * exit 7 when a requested check is blocked (a prerequisite is missing);
 * otherwise 0. Skipped checks never fail a run but are always reported.
 */
import { defineCommand } from "citty";
import { renderVerification } from "../cli/render.ts";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { VerificationProfile } from "../core/contracts/common.ts";
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
      const failed = report.evidence.some((entry) => entry.status === "fail");
      const blocked = report.evidence.some((entry) => entry.status === "blocked");
      return {
        ok: !failed,
        data: report,
        refs: { evidence: report.evidence.map((entry) => entry.id) },
        exitCode: failed ? EXIT_V2.STITCH : blocked ? EXIT_V2.BLOCKED : EXIT_V2.OK,
        human: () => console.log(renderVerification(report)),
      };
    });
  },
});
