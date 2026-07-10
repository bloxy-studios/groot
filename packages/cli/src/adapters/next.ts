/**
 * Next.js adapter — docs/scaffold-flows.md#2.
 *
 * Every flag is passed explicitly: create-next-app's `--yes` reuses *saved user
 * preferences* for unprovided options, so determinism requires a complete flag set.
 * `--disable-git` and `--skip-install` suppress the monorepo-hostile side effects.
 */
import type { AdapterContext, GeneratorCommand, ScaffoldAdapter } from "../engine/adapter.ts";

export const nextAdapter: ScaffoldAdapter = {
  id: "next",
  slot: "web",
  command(ctx: AdapterContext): GeneratorCommand {
    return {
      argv: [
        "bunx",
        `create-next-app@16`,
        ctx.scaffold.path,
        "--ts",
        "--tailwind",
        "--eslint",
        "--app",
        "--src-dir",
        "--turbopack",
        "--import-alias",
        "@/*",
        "--use-bun",
        "--skip-install",
        "--disable-git",
        "--yes",
      ],
      cwd: ctx.plan.targetDir,
      label: `Growing ${ctx.scaffold.path} (Next.js)`,
    };
  },
};
