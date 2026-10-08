/**
 * Projects for the recipe test suites (never imported by runtime code).
 *
 * The create-hono files reproduce create-hono 0.19.5's bun template exactly
 * as the real generator wrote them on 2026-10-08 (single quotes, no
 * semicolons, no trailing newline in the JSON files), so offline tests plan
 * against the bytes the certification suite gets from the generator itself.
 * The adopted project is a deliberately customized layout: entry
 * server/main.ts, an app variable named `api` with a generic, port 4310,
 * custom scripts, typecheck tooling, and a human AGENTS.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CREATE_HONO_INDEX =
  "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nexport default app\n";

export function createHonoPackage(name: string): string {
  return `{\n  "name": "${name}",\n  "scripts": {\n    "dev": "bun run --hot src/index.ts"\n  },\n  "dependencies": {\n    "hono": "^4.13.13"\n  },\n  "devDependencies": {\n    "@types/bun": "latest"\n  }\n}`;
}

const CREATE_HONO_TSCONFIG =
  '{\n  "compilerOptions": {\n    "strict": true,\n    "types": ["bun"],\n    "jsx": "react-jsx",\n    "jsxImportSource": "hono/jsx"\n  }\n}';

export const ADOPTED_MAIN = `import { Hono } from "hono";
import { health } from "./routes/health";

// Hand-written API — human code Groot must keep intact.
const PORT = Number(process.env.PORT ?? 4310);

export const api = new Hono<{ Variables: { startedAt: number } }>();

api.use("*", async (c, next) => {
  c.set("startedAt", Date.now());
  await next();
});
api.route("/health", health);
api.get("/", (c) => c.json({ service: "acme-notes-api", ok: true }));

export default {
  port: PORT,
  fetch: api.fetch,
};
`;

const ADOPTED_HEALTH = `import { Hono } from "hono";

export const health = new Hono().get("/", (c) => c.json({ ok: true, uptime: process.uptime() }));
`;

export const ADOPTED_AGENTS = `# acme-notes-api

House rules for coding agents:
- Routes live in server/routes; keep handlers small.
- Never commit .env files.
`;

const ADOPTED_PACKAGE = `{
  "name": "acme-notes-api",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch server/main.ts",
    "start": "bun server/main.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "4.13.13"
  },
  "devDependencies": {
    "@types/bun": "1.4.2",
    "typescript": "7.0.2"
  }
}
`;

const ADOPTED_TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["server"]
}
`;

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** create-hono's bun template in `dir` (offline stand-in for the real generator). */
export function writeCreateHonoApp(dir: string, name: string): void {
  writeFiles(dir, {
    "package.json": createHonoPackage(name),
    "tsconfig.json": CREATE_HONO_TSCONFIG,
    ".gitignore": "# deps\nnode_modules/\n",
    "src/index.ts": CREATE_HONO_INDEX,
  });
}

/** A Bun workspace root around apps/* (the API app comes from create-hono). */
export function writeWorkspaceRoot(root: string, name: string): void {
  writeFiles(root, {
    "package.json": `{\n  "name": "${name}",\n  "private": true,\n  "workspaces": ["apps/*"]\n}\n`,
    ".gitignore": "node_modules\n",
  });
}

export function writeAdoptedProject(root: string): void {
  writeFiles(root, {
    "package.json": ADOPTED_PACKAGE,
    "tsconfig.json": ADOPTED_TSCONFIG,
    ".gitignore": "node_modules/\ndist/\n",
    "AGENTS.md": ADOPTED_AGENTS,
    "server/main.ts": ADOPTED_MAIN,
    "server/routes/health.ts": ADOPTED_HEALTH,
  });
}

function run(root: string, argv: string[]): void {
  const result = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

/** git init + one commit, with a local identity so it works on any machine. */
export function commitAll(root: string, message = "initial"): void {
  run(root, ["git", "init", "-q", "-b", "main"]);
  run(root, ["git", "config", "user.email", "fixtures@groot.invalid"]);
  run(root, ["git", "config", "user.name", "groot fixtures"]);
  run(root, ["git", "config", "commit.gpgsign", "false"]);
  run(root, ["git", "add", "-A"]);
  run(root, ["git", "commit", "-q", "-m", message]);
}
