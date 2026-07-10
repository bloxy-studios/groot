/**
 * Convex adapter — docs/scaffold-flows.md#7.
 *
 * No offline official generator exists, and `convex codegen` (≥ 1.42) requires a
 * configured deployment even for --init (verified 2026-07-10). So groot does what
 * Convex's own templates do: write the package directly and SHIP the standard
 * `convex/_generated` stubs (vendored from get-convex/templates), which make the
 * backend typecheck before any login. The first `bunx convex dev` run — surfaced
 * as the user's next step, never run by groot — regenerates them against the
 * live deployment.
 */
import type { AdapterContext, FileSpec, ScaffoldAdapter } from "../engine/adapter.ts";
import {
  API_D_TS,
  API_JS,
  CONVEX_TSCONFIG,
  DATA_MODEL_D_TS,
  SERVER_D_TS,
  SERVER_JS,
} from "./convex-generated-stubs.ts";

export function convexPackageJson(packageName: string): string {
  return `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      private: true,
      scripts: {
        dev: "convex dev",
        setup: "convex dev --until-success",
        typecheck: "tsc --noEmit -p convex",
      },
      dependencies: {
        convex: "^1.42.1",
      },
      devDependencies: {
        // Required by the vendored convex/tsconfig.json ("types": ["node"]) —
        // convex dev's built-in typecheck fails without it. Pin tracks the
        // upstream template (get-convex/templates).
        "@types/node": "^24.12.2",
        typescript: "^5.9.3",
      },
    },
    null,
    2,
  )}\n`;
}

const CONVEX_SCHEMA = `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Starter schema — replace with your tables. https://docs.convex.dev/database/schemas
export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
  }),
});
`;

/** Starter functions matching the schema; api.d.ts in the stubs references this module. */
const CONVEX_MESSAGES = `import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("messages").order("desc").take(50);
  },
});

export const send = mutation({
  args: { author: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", args);
  },
});
`;

const CONVEX_ENV_EXAMPLE = `# Written by \`bun run setup\` (convex dev --until-success) after you log in.
CONVEX_DEPLOYMENT=
CONVEX_URL=
`;

function convexReadme(packageName: string): string {
  return `# ${packageName}

[Convex](https://convex.dev) backend, planted by [groot](https://github.com/bloxy-studios/groot).

## First run (interactive — requires a Convex account)

\`\`\`sh
bun run setup   # convex dev --until-success: logs in, provisions a dev deployment, writes .env.local
\`\`\`

Then \`bun run dev\` keeps functions and generated types in sync while you build.

Starter code: \`convex/schema.ts\` (a messages table) and \`convex/messages.ts\`
(a query + mutation). \`convex/_generated\` ships as the standard stubs so the
package typechecks before your first login; \`convex dev\` regenerates it — and
it's committed on purpose, as Convex recommends.

Apps in this workspace consume the generated API via deep imports:

\`\`\`ts
import { api } from "${packageName}/convex/_generated/api";
\`\`\`
`;
}

export const convexAdapter: ScaffoldAdapter = {
  id: "convex",
  slot: "backend",
  command(): null {
    return null;
  },
  writeFiles(ctx: AdapterContext): FileSpec[] {
    const base = ctx.scaffold.path;
    const packageName = `${ctx.plan.conventions.packagesNamespace}/backend`;
    return [
      { path: `${base}/package.json`, contents: convexPackageJson(packageName) },
      { path: `${base}/convex/schema.ts`, contents: CONVEX_SCHEMA },
      { path: `${base}/convex/messages.ts`, contents: CONVEX_MESSAGES },
      { path: `${base}/convex/tsconfig.json`, contents: CONVEX_TSCONFIG },
      { path: `${base}/convex/_generated/api.d.ts`, contents: API_D_TS },
      { path: `${base}/convex/_generated/api.js`, contents: API_JS },
      { path: `${base}/convex/_generated/dataModel.d.ts`, contents: DATA_MODEL_D_TS },
      { path: `${base}/convex/_generated/server.d.ts`, contents: SERVER_D_TS },
      { path: `${base}/convex/_generated/server.js`, contents: SERVER_JS },
      { path: `${base}/.env.example`, contents: CONVEX_ENV_EXAMPLE },
      { path: `${base}/README.md`, contents: convexReadme(packageName) },
    ];
  },
};
