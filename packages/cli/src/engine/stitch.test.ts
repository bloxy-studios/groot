import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "./plan.ts";
import { stitch } from "./stitch.ts";
import type { Plan, Slot } from "./types.ts";

/** Build a fixture tree simulating raw post-generate output, then stitch it. */
async function fixture(selections: Record<Slot, string>): Promise<{ plan: Plan; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "groot-stitch-"));
  const root = join(base, "demo");
  const plan = buildPlan({
    name: "demo",
    targetDir: root,
    cliVersion: "0.2.0",
    selections,
    options: {
      install: false,
      git: false,
      dirConflict: "error",
      keepFailed: false,
      verbose: false,
    },
  });

  const write = async (relPath: string, contents: string): Promise<void> => {
    const absPath = join(root, relPath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  };

  // Trunk output (bun-transformed create-turbo, examples already cleaned).
  await write(
    "package.json",
    JSON.stringify(
      { name: "my-turborepo", private: true, workspaces: ["apps/*", "packages/*"] },
      null,
      2,
    ),
  );
  await write(
    "turbo.json",
    JSON.stringify(
      { $schema: "https://turborepo.dev/schema.json", tasks: { build: { dependsOn: ["^build"] } } },
      null,
      2,
    ),
  );
  await write(".gitignore", "node_modules\n.turbo\n");

  for (const scaffold of plan.scaffolds) {
    if (scaffold.framework === "sveltekit") {
      // sv names the package after the full path argument — invalid as a package name.
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify({ name: "apps/web", private: true }, null, 2),
      );
      await write(`${scaffold.path}/bun.lock`, "{}");
    } else if (scaffold.framework === "next") {
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify({ name: "web", private: true }, null, 2),
      );
      await write(`${scaffold.path}/package-lock.json`, "{}");
    } else if (scaffold.framework === "hono") {
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify({ name: "api", dependencies: { hono: "^4.12.27" } }, null, 2),
      );
      await write(
        `${scaffold.path}/src/index.ts`,
        "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('Hello Hono!'))\nexport default app\n",
      );
    } else if (scaffold.framework === "convex") {
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify({ name: "@repo/backend", private: true }, null, 2),
      );
    } else if (scaffold.framework === "expo") {
      await write(`${scaffold.path}/package.json`, JSON.stringify({ name: "mobile" }, null, 2));
    }
  }
  return { plan, root };
}

describe("stitch (docs/architecture.md#4-stitch)", () => {
  test("full pass: names, lockfiles, ports, backend links, turbo outputs, manifest", async () => {
    const { plan, root } = await fixture({
      web: "sveltekit",
      mobile: "none",
      api: "hono",
      backend: "convex",
    });
    const notes = await stitch(plan);

    // App renamed from sv's invalid path-name to the bare basename.
    const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
    expect(webPkg.name).toBe("web");

    // Nested lockfile removed.
    expect(existsSync(join(root, "apps/web/bun.lock"))).toBe(false);

    // Hono port rewritten to the plan's assignment.
    const honoIndex = await readFile(join(root, "apps/api/src/index.ts"), "utf8");
    expect(honoIndex).toContain("port: 3001");
    expect(honoIndex).toContain("fetch: app.fetch");
    expect(honoIndex).not.toContain("export default app\n");

    // Frontend linked to the backend.
    expect(webPkg.dependencies["@repo/backend"]).toBe("workspace:*");
    const env = await readFile(join(root, ".env.example"), "utf8");
    expect(env).toContain("NEXT_PUBLIC_CONVEX_URL=");

    // Turbo build outputs tuned per framework.
    const turbo = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
    expect(turbo.tasks.build.outputs).toContain(".svelte-kit/**");
    expect(turbo.tasks.build.outputs).toContain("dist/**");
    expect(turbo.tasks.build.outputs).not.toContain(".next/**");

    // Root identity + gitignore + manifest.
    const rootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(rootPkg.name).toBe("demo");
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("!.env.example");
    const manifest = JSON.parse(await readFile(join(root, "groot.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.scaffolds).toHaveLength(3);

    expect(notes.length).toBeGreaterThanOrEqual(6);
  });

  test("is idempotent — a second pass changes nothing and reports fewer ops", async () => {
    const { plan, root } = await fixture({
      web: "sveltekit",
      mobile: "none",
      api: "hono",
      backend: "convex",
    });
    await stitch(plan);
    const before = await readFile(join(root, "apps/api/src/index.ts"), "utf8");
    const secondNotes = await stitch(plan);
    const after = await readFile(join(root, "apps/api/src/index.ts"), "utf8");

    expect(after).toBe(before);
    // Renames/links/lockfiles already applied — second pass must not repeat them.
    expect(secondNotes.join("\n")).not.toContain("depends on @repo/backend");
    expect(secondNotes.join("\n")).not.toContain('name "web"');
    const env = await readFile(join(root, ".env.example"), "utf8");
    expect(env.match(/NEXT_PUBLIC_CONVEX_URL=/g)).toHaveLength(1);
  });

  test("without a backend, no links or env entries appear", async () => {
    const { plan, root } = await fixture({
      web: "next",
      mobile: "none",
      api: "none",
      backend: "none",
    });
    await stitch(plan);
    const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
    expect(webPkg.dependencies?.["@repo/backend"]).toBeUndefined();
    expect(existsSync(join(root, ".env.example"))).toBe(false);
    const turbo = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
    expect(turbo.tasks.build.outputs).toContain(".next/**");
    expect(turbo.tasks.build.outputs).toContain("!.next/cache/**");
  });

  test("hono port rewrite degrades gracefully when the template shape changed", async () => {
    const { plan, root } = await fixture({
      web: "none",
      mobile: "none",
      api: "hono",
      backend: "none",
    });
    await writeFile(
      join(root, "apps/api/src/index.ts"),
      "import { Hono } from 'hono'\nconst app = new Hono()\nBun.serve({ fetch: app.fetch })\n",
      "utf8",
    );
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("marker not found");
  });
});
