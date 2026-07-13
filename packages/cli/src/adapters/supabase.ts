/**
 * Supabase adapter — docs/scaffold-flows.md#17. Second backend-slot choice
 * next to Convex (all facts verified against the published supabase@2.109.1
 * npm package and the cli monorepo's Go sources, then confirmed by running
 * the real linux-x64 binary).
 *
 * `supabase init` is genuinely non-interactive by default in 2.x: the IDE
 * prompts moved behind an opt-in `--interactive` flag that ALSO requires a
 * TTY (cmd/init.go), and the command pins WORKDIR to "." precisely to avoid
 * walking up to a parent project. It writes exactly `supabase/config.toml`
 * (plus `supabase/.gitignore` when an enclosing git repo exists — contained
 * inside the scaffold either way), errors on an existing config (exit 1,
 * `--force` to overwrite), and never installs, git-inits, or shells anything —
 * it's a Go binary. The npm wrapper is a 3-file shim that exec's a platform
 * binary shipped as optionalDependencies (`@supabase/cli-<platform>`): no
 * postinstall, so bun's lifecycle-script trust list is never involved, and
 * no staging is needed.
 *
 * groot writes the package shell first (writeFiles: package.json, tsconfig,
 * a placeholder database.types.ts so the package typechecks before Docker
 * ever runs, README, .env.example) and then runs init as a postCommand inside
 * it — the Convex layout with the official generator in the middle. Docker
 * (`supabase start`), login/link, and real `gen types` output stay deferred
 * to next-steps, exactly like Convex's login.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  FileSpec,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

export function supabasePackageJson(packageName: string): string {
  return `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        // Local stack — requires Docker (deferred to next steps, never run by groot).
        dev: "supabase start",
        stop: "supabase stop",
        typegen: "supabase gen types typescript --local > database.types.ts",
        typecheck: "tsc --noEmit",
      },
      devDependencies: {
        // The CLI: a shim + platform binaries via optionalDependencies — no
        // postinstall, so no trustedDependencies grant is needed (verified
        // against the published 2.109.1 package).
        supabase: "^2.109.1",
        typescript: "^5.9.3",
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Placeholder for the file `bun run typegen` regenerates against the local
 * database — the Convex vendored-stubs pattern: the package (and every app
 * deep-importing the Database type) typechecks before Docker or a login
 * exists. Shape mirrors `supabase gen types typescript` output for an empty
 * public schema.
 */
export const SUPABASE_TYPES_PLACEHOLDER = `/**
 * Regenerate against your schema with \`bun run typegen\`
 * (supabase gen types typescript --local > database.types.ts — needs the
 * local stack running: \`bun run dev\`). This placeholder matches the
 * generated shape for an empty public schema so everything typechecks
 * before Docker ever starts.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
`;

const SUPABASE_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleResolution: "bundler",
      moduleDetection: "force",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["database.types.ts"],
  },
  null,
  2,
)}\n`;

const SUPABASE_ENV_EXAMPLE = `# Local values — \`bun run dev\` (supabase start) prints them once the Docker
# stack is up. Cloud values live in your project's dashboard (API settings).
SUPABASE_URL=
SUPABASE_ANON_KEY=
`;

function supabaseReadme(packageName: string): string {
  return `# ${packageName}

[Supabase](https://supabase.com) backend, planted by [groot](https://github.com/bloxy-studios/groot).

## First run (requires Docker)

\`\`\`sh
bun run dev    # supabase start — boots the local stack, prints the API URL + anon key
bun run stop   # supabase stop
\`\`\`

Config lives in \`supabase/config.toml\` (ports, auth, storage — written by the
official \`supabase init\`). Migrations and functions grow under \`supabase/\` as
you use the CLI.

## Types

\`database.types.ts\` ships as a placeholder for an empty schema so the
workspace typechecks before Docker ever runs. After schema changes:

\`\`\`sh
bun run typegen   # supabase gen types typescript --local > database.types.ts
\`\`\`

Apps in this workspace consume the generated types via deep imports:

\`\`\`ts
import type { Database } from "${packageName}/database.types";
\`\`\`

## Going to the cloud (interactive — requires a Supabase account)

\`\`\`sh
bunx supabase login
bunx supabase link --project-ref <your-project-ref>
\`\`\`
`;
}

export const supabaseAdapter: ScaffoldAdapter = {
  id: "supabase",
  slot: "backend",
  command(): null {
    return null;
  },
  writeFiles(ctx: AdapterContext): FileSpec[] {
    const base = ctx.scaffold.path;
    const packageName = `${ctx.plan.conventions.packagesNamespace}/backend`;
    return [
      { path: `${base}/package.json`, contents: supabasePackageJson(packageName) },
      { path: `${base}/tsconfig.json`, contents: SUPABASE_TSCONFIG },
      { path: `${base}/database.types.ts`, contents: SUPABASE_TYPES_PLACEHOLDER },
      { path: `${base}/.env.example`, contents: SUPABASE_ENV_EXAMPLE },
      { path: `${base}/README.md`, contents: supabaseReadme(packageName) },
    ];
  },
  postCommands(ctx: AdapterContext): GeneratorCommand[] {
    return [
      {
        // Runs AFTER writeFiles, so the scaffold directory exists — init has
        // no directory argument and writes ./supabase into its cwd. Fresh-dir
        // planning guarantees no existing config (which would exit 1).
        argv: ["bunx", "supabase@2", "init"],
        cwd: join(ctx.plan.targetDir, ctx.scaffold.path),
        label: `Initializing ${ctx.scaffold.path} (Supabase)`,
      },
    ];
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const configOk = existsSync(join(base, "supabase/config.toml"));
    const typesOk = existsSync(join(base, "database.types.ts"));
    return [
      {
        name: `${ctx.scaffold.path} supabase config`,
        status: configOk ? "pass" : "fail",
        detail: configOk ? "supabase/config.toml present" : "supabase/config.toml missing",
        ...(configOk
          ? {}
          : {
              fix: `Run \`bunx supabase init\` in ${ctx.scaffold.path} or remove the scaffold from groot.json.`,
            }),
      },
      {
        name: `${ctx.scaffold.path} database types`,
        status: typesOk ? "pass" : "warn",
        detail: typesOk
          ? "database.types.ts present"
          : "database.types.ts missing — apps deep-importing the Database type won't typecheck",
        ...(typesOk
          ? {}
          : {
              fix: "Run `bun run typegen` in the backend package (needs the local stack running).",
            }),
      },
    ];
  },
};
