/**
 * React Router (framework mode) adapter — docs/scaffold-flows.md#12. Fifth
 * web-slot choice; the Remix successor's official scaffolder.
 *
 * `create-react-router@8` is fully non-interactive with `--yes` (all flags
 * verified against the published 8.2.0 source): `--no-git-init`,
 * `--no-install`, `--package-manager bun`, and `--no-agent-skills` — v8.2
 * added a step that copies React Router's own agent skill files into the
 * project; groot suppresses it like TanStack's `--no-intent` and Astro's
 * `--no-ai` (groot's own agent-era artifacts arrive with roadmap v1.3).
 * The default template is fetched from remix-run/react-router-templates
 * (GitHub) at scaffold time: TS + Tailwind + SSR (+ a Dockerfile, kept as-is).
 *
 * The positional doubles as the project-name source (same toValidProjectName
 * shape as create-astro), so the spawn runs from the scaffold's parent with
 * the bare basename. Port 5173 is the Vite default — shared with SvelteKit,
 * the same-slot-alternatives-share-ports precedent (elysia/hono on 3001).
 * Build: `react-router build` → build/ (client + server).
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

export const reactRouterAdapter: ScaffoldAdapter = {
  id: "react-router",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "create-react-router@8",
        name,
        "--package-manager",
        "bun",
        "--no-git-init",
        "--no-install",
        "--no-agent-skills",
        "--yes",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (React Router)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    // react-router.config — the definitive framework-mode marker.
    const configPresent = ["react-router.config.ts", "react-router.config.js"].some((file) =>
      existsSync(join(base, file)),
    );
    return [
      {
        name: `${ctx.scaffold.path} react-router config`,
        status: configPresent ? "pass" : "warn",
        detail: configPresent
          ? "react-router.config present"
          : "no react-router.config.{ts,js} found",
        ...(configPresent
          ? {}
          : { fix: "Restore the react-router.config the framework-mode template ships." }),
      },
    ];
  },
};
