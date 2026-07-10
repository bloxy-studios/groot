/**
 * Next.js adapter — docs/scaffold-flows.md#2.
 *
 * Every flag is passed explicitly: create-next-app's `--yes` reuses *saved user
 * preferences* for unprovided options, so determinism requires a complete flag set.
 * `--disable-git` and `--skip-install` suppress the monorepo-hostile side effects.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

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
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const configOk = ["next.config.ts", "next.config.mjs", "next.config.js"].some((file) =>
      existsSync(join(base, file)),
    );
    return [
      {
        name: `${ctx.scaffold.path} next config`,
        status: configOk ? "pass" : "warn",
        detail: configOk ? "next.config present" : "no next.config.{ts,mjs,js} found",
        ...(configOk ? {} : { fix: "Restore the Next.js config file (next.config.ts)." }),
      },
    ];
  },
};
