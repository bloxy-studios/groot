/**
 * Elysia adapter — docs/scaffold-flows.md#5.
 *
 * groot writes these files directly instead of shelling out: `bun create elysia`
 * resolves to a community-owned scaffolder whose template diverges from Elysia's
 * own documented setup (it lacks the dev script). The files below follow the
 * official manual-setup docs, with the dev port applied from the plan.
 */
import type { AdapterContext, FileSpec, ScaffoldAdapter } from "../engine/adapter.ts";

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
};
