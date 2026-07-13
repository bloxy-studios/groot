import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "./plan.ts";
import { stitch, stitchBackendLinks, stitchTrustedDependencies } from "./stitch.ts";
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
    } else if (scaffold.framework === "fastify") {
      // The published app-ts-esm template's package.json shape after
      // `npm init -y` + fastify-cli's merge (fastify-cli 8.0.0 generate.js):
      // Node-centric `fastify start` dev plus npm-invoking script chains.
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify(
          {
            name: "api",
            version: "1.0.0",
            main: "app.ts",
            type: "module",
            scripts: {
              test: "npm run build:ts && tsc -p test/tsconfig.json && FASTIFY_AUTOLOAD_TYPESCRIPT=1 node --test --experimental-test-coverage --loader ts-node/esm test/**/*.ts",
              start: "npm run build:ts && fastify start -l info dist/app.js",
              "build:ts": "tsc",
              "watch:ts": "tsc -w",
              dev: "fastify start -l info src/app.ts",
              "dev:start": "fastify start --ignore-watch=.ts$ -w -l info -P dist/app.js",
            },
            dependencies: { fastify: "^5.0.0", "fastify-cli": "^8.0.0" },
            devDependencies: { "ts-node": "^10.9.2", typescript: "^5.9.3" },
          },
          null,
          2,
        ),
      );
      await write(`${scaffold.path}/src/server.ts`, "// groot overlay placeholder\n");
    } else if (scaffold.framework === "react-native") {
      // Post-init shape: placeholders already replaced (HelloWorld -> mobile),
      // metro.config.js as shipped by @react-native-community/template 0.86.0.
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify(
          {
            name: "mobile",
            version: "0.0.1",
            private: true,
            scripts: { start: "react-native start", test: "jest" },
            dependencies: { "react-native": "0.86.0", react: "19.2.3" },
          },
          null,
          2,
        ),
      );
      await write(
        `${scaffold.path}/metro.config.js`,
        [
          "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');",
          "",
          "/**",
          " * Metro configuration",
          " * https://reactnative.dev/docs/metro",
          " *",
          " * @type {import('@react-native/metro-config').MetroConfig}",
          " */",
          "const config = {};",
          "",
          "module.exports = mergeConfig(getDefaultConfig(__dirname), config);",
          "",
        ].join("\n"),
      );
    } else if (scaffold.framework === "supabase") {
      // Post-generate shape: groot's package shell + the real init's output
      // (config.toml project_id defaults to the cwd basename — verified by
      // running the 2.109.1 binary).
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify(
          { name: "@repo/backend", private: true, devDependencies: { supabase: "^2.109.1" } },
          null,
          2,
        ),
      );
      await write(
        `${scaffold.path}/supabase/config.toml`,
        [
          "# A string used to distinguish different Supabase projects on the same host. Defaults to the",
          "# working directory name when running `supabase init`.",
          'project_id = "backend"',
          "",
          "[api]",
          "enabled = true",
          "port = 54321",
          "",
        ].join("\n"),
      );
    } else if (scaffold.framework === "convex") {
      await write(
        `${scaffold.path}/package.json`,
        JSON.stringify({ name: "@repo/backend", private: true }, null, 2),
      );
    } else if (scaffold.framework === "expo") {
      await write(`${scaffold.path}/package.json`, JSON.stringify({ name: "mobile" }, null, 2));
    } else if (scaffold.framework === "tanstack-start") {
      await write(`${scaffold.path}/package.json`, JSON.stringify({ name: "web" }, null, 2));
    }
  }
  return { plan, root };
}

describe("stitch (docs/architecture.md#4-stitch)", () => {
  test("full pass: names, lockfiles, ports, backend links, turbo outputs, manifest", async () => {
    const { plan, root } = await fixture({
      web: "sveltekit",
      mobile: "none",
      desktop: "none",
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
    // SvelteKit reads $env/static/public → PUBLIC_* (anchored: substring of NEXT_PUBLIC_).
    expect(env).toMatch(/^PUBLIC_CONVEX_URL=/m);

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
      desktop: "none",
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
    expect(env.match(/^PUBLIC_CONVEX_URL=/gm)).toHaveLength(1);
  });

  test("without a backend, no links or env entries appear", async () => {
    const { plan, root } = await fixture({
      web: "next",
      mobile: "none",
      desktop: "none",
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
      desktop: "none",
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

describe("stitchFastifyScripts (bun-first scripts — scaffold-flows.md#15)", () => {
  const selections: Record<Slot, string> = {
    web: "none",
    mobile: "none",
    desktop: "none",
    api: "fastify",
    backend: "none",
  };

  test("swaps the template's Node-centric scripts for the bun-native set", async () => {
    const { plan, root } = await fixture(selections);
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("bun-native scripts");

    const pkg = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));
    expect(pkg.scripts).toEqual({
      dev: "bun --watch src/server.ts",
      start: "NODE_ENV=production bun src/server.ts",
      build: "tsc",
      test: "bun test",
      typecheck: "tsc --noEmit",
    });
    // The npm-invoking template chains are gone wholesale (dev:start, watch:ts …).
    expect(JSON.stringify(pkg.scripts)).not.toContain("npm run");
    expect(JSON.stringify(pkg.scripts)).not.toContain("fastify start");
    // Dependencies are upstream's business — the rewrite must not touch them.
    expect(pkg.dependencies["fastify-cli"]).toBe("^8.0.0");
    expect(pkg.devDependencies["ts-node"]).toBe("^10.9.2");
    expect(pkg.type).toBe("module");
  });

  test("is idempotent — a second pass is a silent no-op", async () => {
    const { plan, root } = await fixture(selections);
    await stitch(plan);
    const before = await readFile(join(root, "apps/api/package.json"), "utf8");
    const secondNotes = await stitch(plan);
    const after = await readFile(join(root, "apps/api/package.json"), "utf8");
    expect(after).toBe(before);
    expect(secondNotes.join("\n")).not.toContain("bun-native scripts");
    expect(secondNotes.join("\n")).not.toContain("bun rewrite skipped");
  });

  test("degrades gracefully when the dev script isn't template-shaped", async () => {
    const { plan, root } = await fixture(selections);
    const path = join(root, "apps/api/package.json");
    const pkg = JSON.parse(await readFile(path, "utf8"));
    pkg.scripts = { dev: "node --watch dist/server.js", deploy: "flyctl deploy" };
    await writeFile(path, JSON.stringify(pkg, null, 2), "utf8");

    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("bun rewrite skipped");
    const untouched = JSON.parse(await readFile(path, "utf8"));
    expect(untouched.scripts.dev).toBe("node --watch dist/server.js");
    expect(untouched.scripts.deploy).toBe("flyctl deploy");
  });
});

describe("stitchMetroMonorepo (bare RN workspaces — scaffold-flows.md#16)", () => {
  const selections: Record<Slot, string> = {
    web: "none",
    mobile: "react-native",
    desktop: "none",
    api: "none",
    backend: "none",
  };

  test("rewrites the template's empty config into workspace wiring", async () => {
    const { plan, root } = await fixture(selections);
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("workspace watchFolders");

    const metro = await readFile(join(root, "apps/mobile/metro.config.js"), "utf8");
    expect(metro).toContain("groot: monorepo wiring");
    expect(metro).toContain("watchFolders: [workspaceRoot]");
    expect(metro).toContain("path.resolve(__dirname, '../..')"); // apps/mobile → root
    expect(metro).toContain("path.resolve(workspaceRoot, 'node_modules')");
    // The template's merge line survives — only the empty config was replaced.
    expect(metro).toContain("mergeConfig(getDefaultConfig(__dirname), config)");
    expect(metro).not.toContain("const config = {};");
  });

  test("is idempotent — a second pass changes nothing and stays silent", async () => {
    const { plan, root } = await fixture(selections);
    await stitch(plan);
    const before = await readFile(join(root, "apps/mobile/metro.config.js"), "utf8");
    const secondNotes = await stitch(plan);
    const after = await readFile(join(root, "apps/mobile/metro.config.js"), "utf8");
    expect(after).toBe(before);
    expect(secondNotes.join("\n")).not.toContain("watchFolders");
    expect(secondNotes.join("\n")).not.toContain("wiring skipped");
  });

  test("degrades gracefully when the template shape changed", async () => {
    const { plan, root } = await fixture(selections);
    await writeFile(
      join(root, "apps/mobile/metro.config.js"),
      "module.exports = { resolver: { unstable_enableSymlinks: true } };\n",
      "utf8",
    );
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("monorepo wiring skipped");
    const metro = await readFile(join(root, "apps/mobile/metro.config.js"), "utf8");
    expect(metro).toContain("unstable_enableSymlinks"); // untouched
  });
});

describe("stitchSupabaseProjectId (host uniqueness — scaffold-flows.md#17)", () => {
  const selections: Record<Slot, string> = {
    web: "none",
    mobile: "none",
    desktop: "none",
    api: "none",
    backend: "supabase",
  };

  test("renames the cwd-derived default to the workspace name, idempotently", async () => {
    const { plan, root } = await fixture(selections);
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain('project_id "demo"');

    const config = await readFile(join(root, "packages/backend/supabase/config.toml"), "utf8");
    expect(config).toMatch(/^project_id = "demo"$/m);
    expect(config).not.toMatch(/^project_id = "backend"$/m);
    // The rest of the file is untouched.
    expect(config).toContain("port = 54321");

    const before = config;
    const secondNotes = await stitch(plan);
    expect(await readFile(join(root, "packages/backend/supabase/config.toml"), "utf8")).toBe(
      before,
    );
    expect(secondNotes.join("\n")).not.toContain("project_id");
  });

  test("degrades gracefully when the user renamed project_id themselves", async () => {
    const { plan, root } = await fixture(selections);
    const path = join(root, "packages/backend/supabase/config.toml");
    await writeFile(path, 'project_id = "my-custom-name"\n', "utf8");
    const notes = await stitch(plan);
    expect(notes.join("\n")).toContain("rename skipped");
    expect(await readFile(path, "utf8")).toContain('project_id = "my-custom-name"');
  });
});

describe("stitchBackendLinks — supabase env naming (scaffold-flows.md#17)", () => {
  test("each frontend gets prefixed URL + ANON_KEY pairs; bare RN gets the plain pair", async () => {
    const { plan, root } = await fixture({
      web: "next",
      mobile: "react-native",
      desktop: "none",
      api: "none",
      backend: "supabase",
    });
    await stitch(plan);
    const env = await readFile(join(root, ".env.example"), "utf8");
    // Two lines per frontend — and the plain SUPABASE_URL= must not be
    // swallowed by NEXT_PUBLIC_SUPABASE_URL= (exact-line membership).
    expect(env).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=$/m);
    expect(env).toMatch(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=$/m);
    expect(env).toMatch(/^SUPABASE_URL=$/m);
    expect(env).toMatch(/^SUPABASE_ANON_KEY=$/m);
    expect(env).not.toContain("CONVEX_URL");
    // Workspace dep lands exactly like convex's.
    const webPkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
    expect(webPkg.dependencies["@repo/backend"]).toBe("workspace:*");
    // Idempotent: each line appended exactly once across a second stitch.
    await stitch(plan);
    const envAfter = await readFile(join(root, ".env.example"), "utf8");
    expect(envAfter.match(/^SUPABASE_URL=$/gm)).toHaveLength(1);
    expect(envAfter.match(/^NEXT_PUBLIC_SUPABASE_URL=$/gm)).toHaveLength(1);
  });
});

describe("stitchTrustedDependencies (bun lifecycle — scaffold-flows.md#9)", () => {
  test("electron workspaces get the root trust grant, idempotently", async () => {
    const { plan, root } = await fixture({
      web: "none",
      mobile: "none",
      desktop: "electron",
      api: "none",
      backend: "none",
    });
    const note = await stitchTrustedDependencies(plan);
    expect(note).toContain("trustedDependencies [electron]");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.trustedDependencies).toEqual(["electron"]);

    // Second run: already granted → no-op, no duplicates.
    expect(await stitchTrustedDependencies(plan)).toBeNull();
    const again = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(again.trustedDependencies).toEqual(["electron"]);
  });

  test("non-electron workspaces are left untouched", async () => {
    const { plan, root } = await fixture({
      web: "next",
      mobile: "none",
      desktop: "tauri",
      api: "none",
      backend: "none",
    });
    expect(await stitchTrustedDependencies(plan)).toBeNull();
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect("trustedDependencies" in pkg).toBe(false);
  });
});

describe("stitchBackendLinks — mobile env naming (scaffold-flows.md#7)", () => {
  test("bare RN gets plain CONVEX_URL=, never swallowed by the longer names", async () => {
    const { plan, root } = await fixture({
      web: "next",
      mobile: "react-native",
      desktop: "none",
      api: "none",
      backend: "convex",
    });
    await stitch(plan);
    const env = await readFile(join(root, ".env.example"), "utf8");
    // CONVEX_URL= is a substring of NEXT_PUBLIC_CONVEX_URL= — the exact-line
    // membership must still append it as its own line (anchored asserts).
    expect(env).toMatch(/^NEXT_PUBLIC_CONVEX_URL=/m);
    expect(env).toMatch(/^CONVEX_URL=/m);
    expect(env).not.toMatch(/^EXPO_PUBLIC_CONVEX_URL=/m);
    // And the RN app is linked to the backend like any frontend.
    const pkg = JSON.parse(await readFile(join(root, "apps/mobile/package.json"), "utf8"));
    expect(pkg.dependencies["@repo/backend"]).toBe("workspace:*");
    // Idempotent: a second stitch appends nothing.
    await stitch(plan);
    const envAfter = await readFile(join(root, ".env.example"), "utf8");
    expect(envAfter.match(/^CONVEX_URL=/gm)).toHaveLength(1);
  });
});

describe("stitchBackendLinks — mixed-web env naming (scaffold-flows.md#7)", () => {
  test("each web framework gets ITS env line; substring names never swallow each other", async () => {
    // Hand-built plan: two web scaffolds (next + sveltekit via add --path) + convex.
    const root = await mkdtemp(join(tmpdir(), "groot-stitch-env-"));
    const plan: Plan = {
      name: "mixed",
      targetDir: root,
      createdWith: "create-groot@0.0.0-test",
      conventions: { packagesNamespace: "@repo" },
      scaffolds: [
        {
          slot: "web",
          framework: "next",
          path: "apps/web",
          generator: "create-next-app@16",
          port: 3000,
        },
        {
          slot: "web",
          framework: "sveltekit",
          path: "apps/marketing",
          generator: "sv@0.16",
          port: 5173,
        },
        {
          slot: "backend",
          framework: "convex",
          path: "packages/backend",
          generator: null,
          port: null,
        },
      ],
      options: {
        install: false,
        git: false,
        dirConflict: "error",
        keepFailed: false,
        verbose: false,
      },
    };
    for (const path of ["apps/web", "apps/marketing"]) {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(
        join(root, path, "package.json"),
        JSON.stringify({ name: path.split("/")[1] }),
      );
    }

    await stitchBackendLinks(plan);
    const env = await readFile(join(root, ".env.example"), "utf8");
    expect(env).toMatch(/^NEXT_PUBLIC_CONVEX_URL=/m);
    // The regression: existing.includes() let NEXT_PUBLIC_… swallow this line.
    expect(env).toMatch(/^PUBLIC_CONVEX_URL=/m);

    // Idempotent re-run: exact-line dedup, no duplicates of either.
    await stitchBackendLinks(plan);
    const again = await readFile(join(root, ".env.example"), "utf8");
    expect(again.match(/^NEXT_PUBLIC_CONVEX_URL=/gm)).toHaveLength(1);
    expect(again.match(/^PUBLIC_CONVEX_URL=/gm)).toHaveLength(1);
  });
});
