/**
 * Astro adapter — docs/scaffold-flows.md#11. Fourth web-slot choice.
 *
 * `create-astro` has the cleanest flag surface of the web generators (all
 * verified against the published 5.2.2 source): `--template minimal`,
 * `--no-install`, `--no-git`, `--no-ai` (skip AI agent config files — groot's
 * own agent-era artifacts arrive with roadmap v1.3), `--skip-houston` (skip
 * the mascot animation for deterministic output), `--yes`. Templates are
 * fetched via giget from the withastro/astro examples at scaffold time.
 *
 * ⚠️ Verified caveat: with `--yes` and a NON-empty target, create-astro
 * silently ignores the given directory and scaffolds into a randomly named
 * one (`generateProjectName()`). groot's generate stage guarantees a fresh
 * destination (trunk examples cleared; add requires fresh paths), so the
 * happy path always holds — but never reuse this adapter outside that
 * guarantee. The positional doubles as the project-name source (bare names
 * pass through `toValidName` untouched), so the spawn runs from the
 * scaffold's parent with the bare basename, like the other name-deriving
 * generators.
 *
 * Port 4321 is `astro dev`'s built-in default — the only unique web port in
 * the matrix, nothing to rewrite. TS-strict by default; build → dist/.
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

/** Pinned template — Astro's minimal official example (see scaffold-flows.md#11). */
export const ASTRO_TEMPLATE = "minimal";

export const astroAdapter: ScaffoldAdapter = {
  id: "astro",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "create-astro@5",
        name,
        "--template",
        ASTRO_TEMPLATE,
        "--no-install",
        "--no-git",
        "--no-ai",
        "--skip-houston",
        "--yes",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Astro)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    // astro.config — the template's contract (the minimal example ships .mjs;
    // .ts is a documented user upgrade).
    const configPresent = ["astro.config.mjs", "astro.config.ts", "astro.config.js"].some((file) =>
      existsSync(join(base, file)),
    );
    return [
      {
        name: `${ctx.scaffold.path} astro config`,
        status: configPresent ? "pass" : "warn",
        detail: configPresent ? "astro config present" : "no astro.config.{mjs,ts,js} found",
        ...(configPresent
          ? {}
          : { fix: "Restore the Astro config the create-astro template ships." }),
      },
    ];
  },
};
