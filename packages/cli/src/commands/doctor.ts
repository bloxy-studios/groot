/**
 * `groot doctor` — workspace health checks with suggested fixes
 * (docs/cli-spec.md#groot-doctor-v03). Exits 0 (healthy — warns allowed) or 5
 * (problems found). `--json` emits structured results on pure stdout.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import type { DoctorCheck } from "../engine/adapter.ts";
import { isHealthy, runDoctor } from "../engine/doctor.ts";
import { EXIT, GrootError } from "../engine/errors.ts";
import { loadManifest } from "../engine/manifest.ts";

const ICONS: Record<DoctorCheck["status"], string> = {
  pass: pc.green("✓"),
  warn: pc.yellow("⚠"),
  fail: pc.red("✗"),
};

function printHuman(checks: readonly DoctorCheck[], workspaceRoot: string): void {
  console.log(`${pc.dim("workspace")} ${workspaceRoot}`);
  console.log();
  for (const check of checks) {
    console.log(`${ICONS[check.status]} ${check.name}  ${pc.dim(check.detail)}`);
    if (check.fix !== undefined && check.status !== "pass") {
      console.log(`    ${pc.cyan("fix:")} ${check.fix}`);
    }
  }
  console.log();
  const fails = checks.filter((check) => check.status === "fail").length;
  const warns = checks.filter((check) => check.status === "warn").length;
  if (fails === 0 && warns === 0) {
    console.log(pc.green(pc.bold("🌳 Healthy — every check passed.")));
  } else if (fails === 0) {
    console.log(pc.yellow(pc.bold(`🌱 Healthy with ${warns} warning${warns === 1 ? "" : "s"}.`)));
  } else {
    console.log(
      pc.red(
        pc.bold(
          `✗ ${fails} problem${fails === 1 ? "" : "s"} found (${warns} warning${warns === 1 ? "" : "s"}).`,
        ),
      ),
    );
  }
}

export const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Check the health of a groot workspace",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      description: "Workspace directory (default: walk up from cwd)",
    },
    json: { type: "boolean", default: false, description: "Machine-readable results on stdout" },
  },
  async run({ args }) {
    try {
      const loaded = await loadManifest(args.dir ?? process.cwd());
      const checks = await runDoctor(loaded);
      const healthy = isHealthy(checks);

      if (args.json) {
        console.log(
          JSON.stringify({ healthy, workspaceRoot: loaded.workspaceRoot, checks }, null, 2),
        );
      } else {
        printHuman(checks, loaded.workspaceRoot);
      }
      process.exit(healthy ? EXIT.OK : EXIT.STITCH);
    } catch (error) {
      if (error instanceof GrootError) {
        console.error(`${pc.red("groot error:")} ${error.message}`);
        if (error.hint !== undefined) console.error(`  ${pc.dim(error.hint)}`);
        process.exit(error.exitCode);
      }
      throw error;
    }
  },
});
