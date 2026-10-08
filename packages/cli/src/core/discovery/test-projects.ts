/**
 * Temporary project trees for discovery, blueprint, planner, and command
 * tests (never imported by runtime code). Each builder writes a realistic
 * layout into a fresh temp directory and returns its real path; git
 * fixtures run git with an isolated, empty global config so a developer's
 * hooks, signing, or templates can't leak into test repositories.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GROOT_JSON_SCHEMA_URL } from "../contracts/blueprint.ts";
import { upsertRegion } from "../transforms/regions.ts";

export type Files = Readonly<Record<string, string>>;

/** Values that must never appear in any observation, plan, or command output. */
export const SECRET_VALUES = ["hunter2-super-secret", "sk_live_TOPSECRETVALUE123456"] as const;

export const BUN_LOCK = '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {},\n  },\n}\n';

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeFiles(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

export function makeProject(files: Files, prefix = "groot-discovery-"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFiles(root, files);
  return root;
}

let isolatedGitConfig: string | null = null;

function gitEnv(): Record<string, string | undefined> {
  if (isolatedGitConfig === null) {
    isolatedGitConfig = join(
      realpathSync(mkdtempSync(join(tmpdir(), "groot-gitconfig-"))),
      "config",
    );
    writeFileSync(isolatedGitConfig, "");
  }
  return { ...process.env, GIT_CONFIG_GLOBAL: isolatedGitConfig, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Run git in a fixture (identity and branch fixed; throws on failure). */
export async function git(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=groot-test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: root, env: gitEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

export async function initRepo(root: string): Promise<void> {
  await git(root, "init", "-q");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "initial");
}

/** The CLI entry (packages/cli/src/index.ts), run from source by process-level tests. */
export const CLI_ENTRY = join(import.meta.dir, "../../index.ts");

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Run `groot <args>` as a child process with piped (non-TTY) stdio, like CI and agents do. */
export async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(""),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const HONO_SERVER = `import { Hono } from "hono";
import { routes } from "./routes";

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
for (const route of routes) app.get(route, (c) => c.json({ route }));

const port = Number(process.env.PORT ?? 4310);
export default { port, fetch: app.fetch };
`;

/**
 * (a) A single-app Bun + Hono API with a custom layout: entry server/main.ts,
 * custom scripts, port 4310 only in source, a gitignored .env.local holding
 * secret values, human AGENTS.md + CLAUDE.md, and a git repo with one staged,
 * one unstaged, and one untracked change.
 */
export async function customHonoApp(): Promise<string> {
  const root = makeProject({
    "package.json": json({
      name: "acme-edge",
      private: true,
      type: "module",
      packageManager: "bun@1.3.14",
      scripts: {
        dev: "bun --watch server/main.ts",
        "start:edge": "NODE_ENV=production bun run server/main.ts",
        typecheck: "tsc --noEmit",
      },
      dependencies: { hono: "^4.6.0" },
      devDependencies: { "@types/bun": "^1.3.14", typescript: "^5.9.3" },
    }),
    "bun.lock": BUN_LOCK,
    "tsconfig.json": json({ compilerOptions: { strict: true } }),
    "server/main.ts": HONO_SERVER,
    "server/routes.ts": 'export const routes = ["/health"];\n',
    "README.md": "# acme-edge\n",
    ".gitignore": "node_modules\n.env.local\n",
    ".env.local": [
      `DATABASE_URL=postgres://admin:${SECRET_VALUES[0]}@db.internal:5432/app`,
      `API_SECRET="${SECRET_VALUES[1]}"`,
      "PUBLIC_SITE_URL=https://example.com",
      "",
    ].join("\n"),
    "AGENTS.md": "# Acme edge\n\nHuman notes: deploy only from main.\n",
    "CLAUDE.md": "Read AGENTS.md before changing anything.\n",
  });
  await initRepo(root);
  writeFiles(root, { "README.md": "# acme-edge\n\nA staged note.\n" });
  await git(root, "add", "README.md");
  writeFiles(root, {
    "server/routes.ts": 'export const routes = ["/health", "/v1"];\n',
    "scratch.txt": "untracked notes\n",
  });
  return root;
}

/** (b) A bun monorepo: next web app, hono api, a ui library, a tsconfig preset. */
export function bunMonorepo(extra: Files = {}): string {
  return makeProject({
    "package.json": json({
      name: "acme",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      packageManager: "bun@1.3.14",
      devDependencies: { turbo: "^2.10.4" },
    }),
    "bun.lock": BUN_LOCK,
    "AGENTS.md": "# acme\n\nTeam conventions live here.\n",
    "apps/web/package.json": json({
      name: "web",
      private: true,
      scripts: { dev: "next dev --port 3000", build: "next build" },
      dependencies: { next: "^16.0.0", react: "^19.0.0", "@repo/ui": "workspace:*" },
    }),
    "apps/web/app/page.tsx": "export default function Page() {\n  return null;\n}\n",
    "apps/web/AGENTS.md": "# web\n\nPrefer server components.\n",
    "apps/api/package.json": json({
      name: "api",
      private: true,
      scripts: { dev: "bun run --hot src/index.ts" },
      dependencies: { hono: "^4.6.0", "drizzle-orm": "^0.45.3" },
      devDependencies: { "@types/bun": "^1.3.14" },
    }),
    "apps/api/src/index.ts":
      'import { Hono } from "hono";\n\nconst app = new Hono();\nexport default { port: 3001, fetch: app.fetch };\n',
    "packages/ui/package.json": json({
      name: "@repo/ui",
      private: true,
      exports: { "./button": "./src/button.tsx" },
      devDependencies: { "@repo/typescript-config": "workspace:*", typescript: "^5.9.3" },
    }),
    "packages/ui/src/button.tsx": "export function Button() {\n  return null;\n}\n",
    "packages/typescript-config/package.json": json({
      name: "@repo/typescript-config",
      private: true,
    }),
    "packages/typescript-config/base.json": json({ compilerOptions: { strict: true } }),
    ...extra,
  });
}

export const V1_MANIFEST = {
  $schema: GROOT_JSON_SCHEMA_URL,
  version: 1,
  createdWith: "create-groot@1.10.0",
  conventions: { packagesNamespace: "@repo" },
  scaffolds: [
    {
      slot: "web",
      framework: "next",
      path: "apps/web",
      generator: "create-next-app@16",
      port: 3000,
    },
    { slot: "api", framework: "hono", path: "apps/api", generator: "create-hono@0.19", port: 3001 },
    { slot: "backend", framework: "convex", path: "packages/backend", generator: null, port: null },
  ],
} as const;

/** (c) A groot v1 workspace (next + hono + convex) as `groot init` wrote it. */
export function v1Workspace(manifest: unknown = V1_MANIFEST): string {
  return makeProject({
    "groot.json": json(manifest),
    "package.json": json({
      name: "flagship",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      packageManager: "bun@1.3.14",
    }),
    "bun.lock": BUN_LOCK,
    "apps/web/package.json": json({
      name: "web",
      private: true,
      scripts: { dev: "next dev --port 3000" },
      dependencies: { next: "^16.0.0", react: "^19.0.0" },
    }),
    "apps/api/package.json": json({
      name: "api",
      private: true,
      scripts: { dev: "bun run --hot src/index.ts" },
      dependencies: { hono: "^4.6.0" },
      devDependencies: { "@types/bun": "^1.3.14" },
    }),
    "apps/api/src/index.ts": "export default { port: 3001, fetch: () => new Response('ok') };\n",
    "packages/backend/package.json": json({
      name: "@repo/backend",
      private: true,
      scripts: { dev: "convex dev" },
      dependencies: { convex: "^1.42.1" },
    }),
  });
}

/** (e) A pnpm workspace (inspect-only for Groot). */
export function pnpmWorkspace(): string {
  return makeProject({
    "package.json": json({ name: "pnpm-mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*' # apps\n  - \"packages/*\"\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/web/package.json": json({ name: "web", dependencies: { next: "^16.0.0" } }),
    "packages/utils/package.json": json({ name: "@pnpm-mono/utils", main: "src/index.ts" }),
    "packages/utils/src/index.ts": "export const answer = 42;\n",
  });
}

/** (f) Native-only roots. */
export function cargoOnly(): string {
  return makeProject({
    "Cargo.toml": '[package]\nname = "rusty"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/main.rs": "fn main() {}\n",
  });
}

export function pythonOnly(): string {
  return makeProject({
    "pyproject.toml": '[project]\nname = "snake"\nversion = "0.1.0"\n',
    "snake/__init__.py": "",
  });
}

/** (g) Symlinks leaving the project: a workspace package and an agent file. */
export function monorepoWithOutsideSymlinks(): { root: string; outside: string } {
  const outside = makeProject(
    {
      "pkg/package.json": json({ name: "external", dependencies: { hono: "^4.6.0" } }),
      "CLAUDE.md": "outside instructions\n",
    },
    "groot-outside-",
  );
  const root = bunMonorepo();
  symlinkSync(join(outside, "pkg"), join(root, "packages/external"));
  symlinkSync(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"));
  return { root, outside };
}

/** (h) packageManager says pnpm while a bun.lock is present. */
export function packageManagerContradiction(): string {
  return makeProject({
    "package.json": json({
      name: "torn",
      private: true,
      packageManager: "pnpm@9.12.0",
      scripts: { dev: "bun --watch src/index.ts" },
      dependencies: { hono: "^4.6.0" },
    }),
    "bun.lock": BUN_LOCK,
    "src/index.ts": "export default { port: 3000, fetch: () => new Response('ok') };\n",
  });
}

/** (i) Managed regions: intact (AGENTS.md), hand-edited (CLAUDE.md), malformed (nested AGENTS.md). */
export function managedRegionsProject(): string {
  const intact = upsertRegion(
    "# acme\n\nHuman text.\n",
    {
      regionId: "project-context",
      content: "## map\n- api",
      commentStyle: "html",
      placement: "end",
    },
    "AGENTS.md",
  );
  const generated = upsertRegion(
    "",
    { regionId: "agents-import", content: "@AGENTS.md", commentStyle: "html", placement: "start" },
    "CLAUDE.md",
  );
  return bunMonorepo({
    "AGENTS.md": intact,
    "CLAUDE.md": generated.replace("@AGENTS.md", "@AGENTS.md\nmy own edit inside the region"),
    "apps/api/AGENTS.md":
      "# api\n\n<!-- groot:begin project-context sha256:0000 -->\nno end marker\n",
  });
}
