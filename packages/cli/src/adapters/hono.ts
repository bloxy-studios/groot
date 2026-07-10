/**
 * Hono adapter — docs/scaffold-flows.md#6.
 *
 * create-hono never git-inits. Its install confirmation has NO negative flag
 * (only -i opts in), and an unanswered prompt aborts the whole scaffold — so
 * groot pre-answers "n" via stdin (verified against create-hono 0.19.4).
 * It also interactively confirms on a non-empty target with no bypass flag,
 * so the generate stage guarantees a fresh directory (trunk examples are
 * removed first). Bun serves the template's default-export app on port 3000;
 * the stitch stage rewrites it to the plan's port.
 */
import type { AdapterContext, GeneratorCommand, ScaffoldAdapter } from "../engine/adapter.ts";

export const honoAdapter: ScaffoldAdapter = {
  id: "hono",
  slot: "api",
  command(ctx: AdapterContext): GeneratorCommand {
    return {
      argv: ["bunx", "create-hono@0.19", ctx.scaffold.path, "--template", "bun", "--pm", "bun"],
      cwd: ctx.plan.targetDir,
      label: `Growing ${ctx.scaffold.path} (Hono)`,
      stdin: "n\n", // "Do you want to install project dependencies?" → no (groot installs at verify)
    };
  },
};
