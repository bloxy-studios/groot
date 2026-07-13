/**
 * Elysia adapter — docs/scaffold-flows.md#5.
 *
 * groot writes these files directly instead of shelling out: `bun create elysia`
 * resolves to a community-owned scaffolder whose template diverges from Elysia's
 * own documented setup (it lacks the dev script). The files below follow the
 * official manual-setup docs, with the dev port applied from the plan.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  FileSpec,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

export function elysiaIndexTs(port: number): string {
  return `import { Elysia } from "elysia";

const app = new Elysia().get("/", () => "Hello from groot 🌱").listen(${port});

console.log(\`🦊 Elysia is running at http://\${app.server?.hostname}:\${app.server?.port}\`);

export type App = typeof app;
`;
}

export function elysiaPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        dev: "bun --watch src/index.ts",
        build: "bun build src/index.ts --target bun --outdir ./dist",
        start: "NODE_ENV=production bun dist/index.js",
        test: "bun test",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        elysia: "^1.4.0",
      },
      devDependencies: {
        "@types/bun": "^1.3.0",
        typescript: "^5.9.3",
      },
    },
    null,
    2,
  )}\n`;
}

const ELYSIA_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleResolution: "bundler",
      moduleDetection: "force",
      types: ["bun"],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src"],
  },
  null,
  2,
)}\n`;

function elysiaReadme(port: number): string {
  return `# api

[Elysia](https://elysiajs.com) API, planted by [groot](https://github.com/bloxy-studios/groot).

\`\`\`sh
bun run dev    # http://localhost:${port}
bun run build  # bundle to dist/
bun run start  # run the production bundle
\`\`\`
`;
}

export const elysiaAdapter: ScaffoldAdapter = {
  id: "elysia",
  slot: "api",
  command(): null {
    return null;
  },
  writeFiles(ctx: AdapterContext): FileSpec[] {
    const base = ctx.scaffold.path;
    // Port is always assigned for api scaffolds (see engine/matrix.ts).
    const port = ctx.scaffold.port ?? 3001;
    return [
      { path: `${base}/src/index.ts`, contents: elysiaIndexTs(port) },
      { path: `${base}/package.json`, contents: elysiaPackageJson("api") },
      { path: `${base}/tsconfig.json`, contents: ELYSIA_TSCONFIG },
      { path: `${base}/README.md`, contents: elysiaReadme(port) },
    ];
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    return [await apiPortCheck(ctx, `.listen(${ctx.scaffold.port})`)];
  },
};

/**
 * Shared port-drift check for API scaffolds: warn (not fail) — drift may be
 * intentional. `file` is the scaffold-relative entry that carries the port
 * (elysia/hono serve from src/index.ts; fastify from groot's src/server.ts).
 */
export async function apiPortCheck(
  ctx: DoctorContext,
  marker: string,
  file = "src/index.ts",
): Promise<DoctorCheck> {
  const name = `${ctx.scaffold.path} dev port`;
  try {
    const source = await readFile(join(ctx.workspaceRoot, ctx.scaffold.path, file), "utf8");
    const matches = source.includes(marker);
    return {
      name,
      status: matches ? "pass" : "warn",
      detail: matches
        ? `${file} serves on :${ctx.scaffold.port}`
        : `${file} no longer matches groot.json's port :${ctx.scaffold.port}`,
      ...(matches
        ? {}
        : { fix: "If the change is intentional, update the port in groot.json to match." }),
    };
  } catch {
    return {
      name,
      status: "fail",
      detail: `${file} missing`,
      fix: `Restore ${ctx.scaffold.path}/${file} or remove the scaffold from groot.json.`,
    };
  }
}
