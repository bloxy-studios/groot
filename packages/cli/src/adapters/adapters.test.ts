import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../engine/adapter.ts";
import { buildPlan } from "../engine/plan.ts";
import type { Plan, PlannedScaffold } from "../engine/types.ts";
import { astroAdapter } from "./astro.ts";
import { convexAdapter } from "./convex.ts";
import { electronAdapter } from "./electron.ts";
import { elysiaAdapter } from "./elysia.ts";
import { expoAdapter } from "./expo.ts";
import { fastifyAdapter, fastifyServerTs } from "./fastify.ts";
import { honoAdapter } from "./hono.ts";
import { ADAPTERS } from "./index.ts";
import { nextAdapter } from "./next.ts";
import { nuxtAdapter } from "./nuxt.ts";
import { METRO_MONOREPO_MARKER, reactNativeAdapter, reactNativeNameError } from "./react-native.ts";
import { reactRouterAdapter } from "./react-router.ts";
import { sveltekitAdapter } from "./sveltekit.ts";
import { tanstackStartAdapter } from "./tanstack-start.ts";
import { identifierSegment, tauriAdapter } from "./tauri.ts";
import { TRUNK_EXAMPLE_PATHS, trunkCommand } from "./trunk.ts";
import { viteAdapter } from "./vite.ts";

const PLAN: Plan = buildPlan({
  name: "demo",
  targetDir: "/work/demo",
  cliVersion: "0.2.0",
  selections: { web: "next", mobile: "expo", desktop: "none", api: "elysia", backend: "convex" },
  options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
});

function ctxFor(
  framework: PlannedScaffold["framework"],
  fallback: PlannedScaffold,
): AdapterContext {
  const scaffold = PLAN.scaffolds.find((s) => s.framework === framework) ?? fallback;
  return { plan: PLAN, scaffold };
}

describe("registry", () => {
  test("covers every framework id and agrees on slot", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([
      "astro",
      "convex",
      "electron",
      "elysia",
      "expo",
      "fastify",
      "hono",
      "next",
      "nuxt",
      "react-native",
      "react-router",
      "sveltekit",
      "tanstack-start",
      "tauri",
      "vite",
    ]);
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      expect(adapter.id).toBe(id as keyof typeof ADAPTERS);
    }
  });
});

describe("trunk (create-turbo — scaffold-flows.md#1)", () => {
  test("uses -m bun with install and git suppressed, and never --skip-transforms", () => {
    const cmd = trunkCommand("/work/.tmp", "/work");
    expect(cmd.argv).toEqual([
      "bunx",
      "create-turbo@2",
      "/work/.tmp",
      "-m",
      "bun",
      "--skip-install",
      "--no-git",
    ]);
    expect(cmd.argv).not.toContain("--skip-transforms"); // conflicts with -m bun
    expect(cmd.cwd).toBe("/work");
  });

  test("example cleanup keeps packages/typescript-config", () => {
    expect(TRUNK_EXAMPLE_PATHS).toContain("apps/web");
    expect(TRUNK_EXAMPLE_PATHS).toContain("apps/docs");
    expect(TRUNK_EXAMPLE_PATHS).toContain("packages/ui");
    expect(TRUNK_EXAMPLE_PATHS).toContain("packages/eslint-config");
    expect(TRUNK_EXAMPLE_PATHS).not.toContain("packages/typescript-config");
  });
});

describe("next (scaffold-flows.md#2)", () => {
  test("passes the complete explicit flag set (no saved-preferences surprises)", () => {
    const cmd = nextAdapter.command(
      ctxFor("next", {
        slot: "web",
        framework: "next",
        path: "apps/web",
        generator: "create-next-app@16",
        port: 3000,
      }),
    );
    expect(cmd).not.toBeNull();
    expect(cmd?.argv.slice(0, 3)).toEqual(["bunx", "create-next-app@16", "apps/web"]);
    for (const flag of [
      "--ts",
      "--tailwind",
      "--eslint",
      "--app",
      "--src-dir",
      "--turbopack",
      "--use-bun",
      "--skip-install",
      "--disable-git",
      "--yes",
    ]) {
      expect(cmd?.argv).toContain(flag);
    }
    expect(cmd?.cwd).toBe("/work/demo");
  });
});

describe("sveltekit (scaffold-flows.md#3)", () => {
  test("uses sv create with ts minimal template and all gates bypassed", () => {
    const cmd = sveltekitAdapter.command({
      plan: PLAN,
      scaffold: {
        slot: "web",
        framework: "sveltekit",
        path: "apps/web",
        generator: "sv@0.16",
        port: 5173,
      },
    });
    expect(cmd?.argv).toEqual([
      "bunx",
      "sv@0.16",
      "create",
      "apps/web",
      "--template",
      "minimal",
      "--types",
      "ts",
      "--no-add-ons",
      "--no-install",
      "--no-dir-check",
    ]);
  });
});

describe("tanstack-start (scaffold-flows.md#10)", () => {
  const tsPlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.3.0",
    selections: {
      web: "tanstack-start",
      mobile: "none",
      desktop: "none",
      api: "none",
      backend: "none",
    },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = tsPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the tanstack-start scaffold in the plan");

  test("runs tanstack create fully silenced, name-not-path, from the parent dir", () => {
    const cmd = tanstackStartAdapter.command({ plan: tsPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "@tanstack/cli@0.69",
      "create",
      "web",
      "--framework",
      "React",
      "--package-manager",
      "bun",
      "--no-git",
      "--no-install",
      "--no-examples",
      "--no-toolchain",
      "--no-intent",
      "--yes",
    ]);
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("doctor: healthy scaffold passes vite config and dev-port checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-tanstack-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    await writeFile(join(root, "apps/web/vite.config.ts"), "export default {};\n");
    await writeFile(
      join(root, "apps/web/package.json"),
      JSON.stringify({ name: "web", scripts: { dev: "vite dev --port 3000" } }),
    );
    const checks = await tanstackStartAdapter.doctor?.({ workspaceRoot: root, scaffold });
    const byName = new Map(checks?.map((check) => [check.name, check]));
    expect(byName.get("apps/web vite config")?.status).toBe("pass");
    expect(byName.get("apps/web dev port")?.status).toBe("pass");
  });

  test("doctor: drifted dev-script port warns; missing package.json fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-tanstack-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    await writeFile(join(root, "apps/web/vite.config.ts"), "export default {};\n");
    await writeFile(
      join(root, "apps/web/package.json"),
      JSON.stringify({ name: "web", scripts: { dev: "vite dev --port 5199" } }),
    );
    let checks = await tanstackStartAdapter.doctor?.({ workspaceRoot: root, scaffold });
    const port = checks?.find((c) => c.name === "apps/web dev port");
    expect(port?.status).toBe("warn");
    expect(port?.detail).toContain(":3000");

    // The substring trap: "--port 30001" contains "--port 3000" but is NOT it.
    await writeFile(
      join(root, "apps/web/package.json"),
      JSON.stringify({ name: "web", scripts: { dev: "vite dev --port 30001" } }),
    );
    checks = await tanstackStartAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web dev port")?.status).toBe("warn");

    const bare = await mkdtemp(join(tmpdir(), "groot-tanstack-"));
    await mkdir(join(bare, "apps/web"), { recursive: true });
    checks = await tanstackStartAdapter.doctor?.({ workspaceRoot: bare, scaffold });
    expect(checks?.find((c) => c.name === "apps/web dev port")?.status).toBe("fail");
  });
});

describe("react-router (scaffold-flows.md#12)", () => {
  const rrPlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.5.0",
    selections: {
      web: "react-router",
      mobile: "none",
      desktop: "none",
      api: "none",
      backend: "none",
    },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = rrPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the react-router scaffold in the plan");

  test("runs create-react-router fully silenced, name-not-path, from the parent dir", () => {
    const cmd = reactRouterAdapter.command({ plan: rrPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-react-router@8",
      "web",
      "--package-manager",
      "bun",
      "--no-git-init",
      "--no-install",
      "--no-agent-skills",
      "--yes",
    ]);
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("declares the Vite default port, shared with sveltekit (same-slot precedent)", () => {
    expect(scaffold.port).toBe(5173);
  });

  test("doctor: framework-mode config presence passes and warns when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-rr-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    let checks = await reactRouterAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web react-router config")?.status).toBe("warn");

    await writeFile(join(root, "apps/web/react-router.config.ts"), "export default {};\n");
    checks = await reactRouterAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web react-router config")?.status).toBe("pass");
  });
});

describe("nuxt (scaffold-flows.md#13)", () => {
  const nuxtPlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.6.0",
    selections: { web: "nuxt", mobile: "none", desktop: "none", api: "none", backend: "none" },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = nuxtPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the nuxt scaffold in the plan");

  test("passes every non-interactive-required arg explicitly (dir, template, pm, gitInit)", () => {
    const cmd = nuxtAdapter.command({ plan: nuxtPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-nuxt@3",
      "web",
      "--template",
      "minimal",
      "--packageManager",
      "bun",
      "--no-gitInit",
      "--no-install",
      "--no-modules",
    ]);
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("doctor: nuxt config presence passes and warns when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-nuxt-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    let checks = await nuxtAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web nuxt config")?.status).toBe("warn");

    await writeFile(join(root, "apps/web/nuxt.config.ts"), "export default {};\n");
    checks = await nuxtAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web nuxt config")?.status).toBe("pass");
  });
});

describe("vite (scaffold-flows.md#14)", () => {
  const vitePlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.6.0",
    selections: { web: "vite", mobile: "none", desktop: "none", api: "none", backend: "none" },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = vitePlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the vite scaffold in the plan");

  test("pins react-ts and suppresses interactivity AND 9.x's immediate mode", () => {
    const cmd = viteAdapter.command({ plan: vitePlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-vite@9",
      "web",
      "--template",
      "react-ts",
      "--no-interactive",
      "--no-immediate",
    ]);
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("doctor: vite config presence passes and warns when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-vite-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    let checks = await viteAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web vite config")?.status).toBe("warn");

    await writeFile(join(root, "apps/web/vite.config.ts"), "export default {};\n");
    checks = await viteAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web vite config")?.status).toBe("pass");
  });
});

describe("astro (scaffold-flows.md#11)", () => {
  const astroPlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.4.0",
    selections: { web: "astro", mobile: "none", desktop: "none", api: "none", backend: "none" },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = astroPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the astro scaffold in the plan");

  test("runs create-astro fully silenced, name-not-path, from the parent dir", () => {
    const cmd = astroAdapter.command({ plan: astroPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-astro@5",
      "web",
      "--template",
      "minimal",
      "--no-install",
      "--no-git",
      "--no-ai",
      "--skip-houston",
      "--yes",
    ]);
    // Bare name: create-astro derives the package name from the positional AND
    // silently redirects non-empty targets to a random dir under --yes — the
    // generate stage's fresh-destination guarantee is load-bearing here.
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("declares the unique web port 4321 (astro dev's built-in default)", () => {
    expect(scaffold.port).toBe(4321);
  });

  test("doctor: config presence passes and warns when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-astro-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    let checks = await astroAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web astro config")?.status).toBe("warn");

    await writeFile(join(root, "apps/web/astro.config.mjs"), "export default {};\n");
    checks = await astroAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/web astro config")?.status).toBe("pass");
  });
});

describe("expo (scaffold-flows.md#4)", () => {
  test("pins the SDK template tag explicitly (SDK 57 transition gotcha)", () => {
    const cmd = expoAdapter.command(
      ctxFor("expo", {
        slot: "mobile",
        framework: "expo",
        path: "apps/mobile",
        generator: "create-expo-app@4",
        port: 8081,
      }),
    );
    expect(cmd?.argv).toContain("--template");
    expect(cmd?.argv).toContain("default@sdk-57");
    expect(cmd?.argv).toContain("--no-install");
    expect(cmd?.argv).toContain("--yes");
  });
});

describe("react-native (bare — scaffold-flows.md#16)", () => {
  const ctx = ctxFor("react-native", {
    slot: "mobile",
    framework: "react-native",
    path: "apps/mobile",
    generator: "@react-native-community/cli@20",
    port: 8081,
  });

  test("runs the official init staged, with every side effect flagged off", () => {
    const cmd = reactNativeAdapter.command(ctx);
    expect(cmd?.argv).toEqual([
      "bunx",
      "@react-native-community/cli@20",
      "init",
      "mobile", // positional = directory + native project name after placeholder replacement
      "--pm",
      "bun",
      "--skip-install",
      "--install-pods",
      "false",
      "--skip-git-init",
      "--replace-directory",
      "false",
    ]);
    // init's registry lookup shells `npm config get registry`, which
    // hard-fails on the workspace's bun devEngines declaration in-tree
    // (EBADDEVENGINES, verified empirically) — staging gives it a neutral
    // ancestry AND lets the user's real registry config apply.
    expect(reactNativeAdapter.stagedGeneration).toBe(true);
    // Fully non-interactive with these flags on a fresh target (verified in
    // the published 20.2.0 bundle) — no prompts, so no stdin script.
    expect(cmd?.stdin).toBeUndefined();
    // Metro wiring comes from the stitch stage, not generate-time overlays.
    expect(reactNativeAdapter.writeFiles).toBeUndefined();
  });

  test("vetoes add --path basenames the RN CLI would reject mid-generate", () => {
    // Rules mirrored from the published validate.js — JS-identifier shape,
    // java keywords (android package segments), template placeholder.
    expect(reactNativeAdapter.validatePath?.("apps/mobile")).toBeNull();
    expect(reactNativeAdapter.validatePath?.("apps/companion")).toBeNull();
    expect(reactNativeAdapter.validatePath?.("apps/rn-app")).toContain("not a valid React Native");
    expect(reactNativeAdapter.validatePath?.("apps/2fast")).toContain("not a valid React Native");
    expect(reactNativeAdapter.validatePath?.("apps/class")).toContain("reserved");
    expect(reactNativeAdapter.validatePath?.("apps/react")).toContain("reserved");
    expect(reactNativeAdapter.validatePath?.("apps/HelloWorldApp")).toContain("HelloWorld");
    expect(reactNativeNameError("mobile")).toBeNull();
  });

  test("doctor warns when metro.config.js lost the workspace wiring", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-rn-doctor-"));
    const scaffold = ctx.scaffold;
    await mkdir(join(root, scaffold.path), { recursive: true });

    // Missing config → fail.
    let checks = await reactNativeAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.[0]?.status).toBe("fail");

    // Template-fresh config without wiring → warn (stitch not applied).
    await writeFile(
      join(root, scaffold.path, "metro.config.js"),
      "const config = {};\nmodule.exports = config;\n",
    );
    checks = await reactNativeAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.[0]?.status).toBe("warn");

    // Stitched config → pass.
    await writeFile(
      join(root, scaffold.path, "metro.config.js"),
      `// ${METRO_MONOREPO_MARKER}\nconst config = { watchFolders: [] };\nmodule.exports = config;\n`,
    );
    checks = await reactNativeAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.[0]?.status).toBe("pass");
  });
});

describe("tauri (scaffold-flows.md#8)", () => {
  const tauriPlan: Plan = buildPlan({
    name: "My Demo_App",
    targetDir: "/work/my-demo",
    cliVersion: "1.1.0",
    selections: { web: "none", mobile: "none", desktop: "tauri", api: "none", backend: "none" },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = tauriPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the tauri scaffold in the plan");

  test("runs create-tauri-app with a bare name from the scaffold's parent dir", () => {
    const cmd = tauriAdapter.command({ plan: tauriPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-tauri-app@4",
      "desktop",
      "--template",
      "react-ts",
      "--manager",
      "bun",
      "--identifier",
      "com.my-demo-app.desktop",
      "--yes",
    ]);
    // The positional must be a bare directory name — the generator derives app
    // and crate names from it — so the spawn runs from the scaffold's parent.
    expect(cmd?.cwd).toBe("/work/my-demo/apps");
  });

  test("identifierSegment builds valid reverse-domain segments", () => {
    expect(identifierSegment("My Demo_App")).toBe("my-demo-app");
    expect(identifierSegment("desktop")).toBe("desktop");
    expect(identifierSegment("--weird--")).toBe("weird");
    expect(identifierSegment("日本語")).toBe("app");
  });

  test("doctor: healthy scaffold passes config, port, and vite checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-tauri-"));
    await mkdir(join(root, "apps/desktop/src-tauri"), { recursive: true });
    await writeFile(
      join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      JSON.stringify({ build: { devUrl: "http://localhost:1420" } }),
    );
    await writeFile(join(root, "apps/desktop/vite.config.ts"), "export default {};\n");
    const checks = await tauriAdapter.doctor?.({ workspaceRoot: root, scaffold });
    const byName = new Map(checks?.map((check) => [check.name, check]));
    expect(byName.get("apps/desktop tauri config")?.status).toBe("pass");
    expect(byName.get("apps/desktop dev port")?.status).toBe("pass");
    expect(byName.get("apps/desktop vite config")?.status).toBe("pass");
    // Environment-dependent: pass with cargo installed, warn without — never fail.
    expect(["pass", "warn"]).toContain(byName.get("apps/desktop rust toolchain")?.status ?? "");
  });

  test("doctor: missing conf fails; drifted devUrl port warns", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-tauri-"));
    await mkdir(join(root, "apps/desktop"), { recursive: true });
    let checks = await tauriAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop tauri config")?.status).toBe("fail");

    await mkdir(join(root, "apps/desktop/src-tauri"), { recursive: true });
    await writeFile(
      join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      JSON.stringify({ build: { devUrl: "http://localhost:5173" } }),
    );
    checks = await tauriAdapter.doctor?.({ workspaceRoot: root, scaffold });
    const port = checks?.find((c) => c.name === "apps/desktop dev port");
    expect(port?.status).toBe("warn");
    expect(port?.detail).toContain(":1420");

    // The substring trap: :14200 contains ":1420" but is NOT port 1420.
    await writeFile(
      join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      JSON.stringify({ build: { devUrl: "http://localhost:14200" } }),
    );
    checks = await tauriAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop dev port")?.status).toBe("warn");

    // Malformed devUrl parses to no port → warn, never a crash or false pass.
    await writeFile(
      join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      JSON.stringify({ build: { devUrl: "not a url" } }),
    );
    checks = await tauriAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop dev port")?.status).toBe("warn");
  });
});

describe("electron (scaffold-flows.md#9)", () => {
  const electronPlan: Plan = buildPlan({
    name: "demo",
    targetDir: "/work/demo",
    cliVersion: "1.2.0",
    selections: { web: "none", mobile: "none", desktop: "electron", api: "none", backend: "none" },
    options: { install: true, git: true, dirConflict: "error", keepFailed: false, verbose: false },
  });
  const scaffold = electronPlan.scaffolds[0];
  if (scaffold === undefined) throw new Error("expected the electron scaffold in the plan");

  test("runs create-electron with a bare name from the scaffold's parent dir, fully silenced", () => {
    const cmd = electronAdapter.command({ plan: electronPlan, scaffold });
    expect(cmd?.argv).toEqual([
      "bunx",
      "@quick-start/create-electron@1",
      "desktop",
      "--template",
      "react-ts",
      "--skip",
    ]);
    // Same name-not-path contract as create-tauri-app: spawn from the parent.
    expect(cmd?.cwd).toBe("/work/demo/apps");
    expect(cmd?.stdin).toBeUndefined();
  });

  test("declares no dev port — electron-vite's renderer server is self-wiring", () => {
    expect(scaffold.port).toBeNull();
  });

  test("doctor: missing config fails; binary check absent when electron isn't installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "groot-electron-"));
    await mkdir(join(root, "apps/desktop"), { recursive: true });
    const checks = await electronAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop electron-vite config")?.status).toBe(
      "fail",
    );
    expect(checks?.some((c) => c.name === "apps/desktop electron binary")).toBe(false);
  });

  test("doctor: blocked postinstall warns; downloaded runtime passes", async () => {
    // Fresh root (Bun.resolveSync caches negative lookups within a process —
    // irrelevant for real doctor runs, which are one resolution per process).
    // The fake package sits in the app's OWN node_modules, mirroring bun 1.3's
    // isolated layout where no top-level node_modules/electron exists.
    const root = await mkdtemp(join(tmpdir(), "groot-electron-"));
    await mkdir(join(root, "apps/desktop/node_modules/electron"), { recursive: true });
    await writeFile(join(root, "apps/desktop/electron.vite.config.ts"), "export default {};\n");
    await writeFile(
      join(root, "apps/desktop/node_modules/electron/package.json"),
      JSON.stringify({ name: "electron", version: "0.0.0-test", main: "index.js" }),
    );
    await writeFile(join(root, "apps/desktop/node_modules/electron/index.js"), "");

    let checks = await electronAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop electron-vite config")?.status).toBe(
      "pass",
    );
    const binary = checks?.find((c) => c.name === "apps/desktop electron binary");
    expect(binary?.status).toBe("warn");
    expect(binary?.fix).toContain("bun pm trust electron");

    // Runtime downloaded → passes (positive resolution result is path-stable).
    await mkdir(join(root, "apps/desktop/node_modules/electron/dist"), { recursive: true });
    checks = await electronAdapter.doctor?.({ workspaceRoot: root, scaffold });
    expect(checks?.find((c) => c.name === "apps/desktop electron binary")?.status).toBe("pass");
  });
});

describe("hono (scaffold-flows.md#6)", () => {
  test("selects the bun template without opting into install", () => {
    const cmd = honoAdapter.command({
      plan: PLAN,
      scaffold: {
        slot: "api",
        framework: "hono",
        path: "apps/api",
        generator: "create-hono@0.19",
        port: 3001,
      },
    });
    expect(cmd?.argv).toEqual([
      "bunx",
      "create-hono@0.19",
      "apps/api",
      "--template",
      "bun",
      "--pm",
      "bun",
    ]);
    expect(cmd?.argv).not.toContain("-i"); // install is opt-in; groot installs at verify
    // The install confirmation has no negative flag and aborts the scaffold when
    // unanswered — groot pre-answers it via stdin (verified on create-hono 0.19.4).
    expect(cmd?.stdin).toBe("n\n");
  });
});

describe("fastify (scaffold-flows.md#15)", () => {
  const ctx = ctxFor("fastify", {
    slot: "api",
    framework: "fastify",
    path: "apps/api",
    generator: "fastify-cli@8",
    port: 3001,
  });

  test("spawns the official generate from the parent dir with the bare name", () => {
    const cmd = fastifyAdapter.command(ctx);
    expect(cmd?.argv).toEqual(["bunx", "fastify-cli@8", "generate", "api", "--lang=ts", "--esm"]);
    // generate refuses existing directories and runs `npm init -y` inside its
    // target (upstream behavior — the package name derives from the basename),
    // so groot spawns from the parent with the bare name, like vite/tanstack.
    expect(cmd?.cwd).toBe("/work/demo/apps");
    // Fully non-interactive (verified in the published 8.0.0 generate.js):
    // no prompts exist, so no stdin script is needed.
    expect(cmd?.stdin).toBeUndefined();
    // generate shells out to `npm init -y`; unstaged, npm's walk-up trips the
    // workspace's bun devEngines guard (EBADDEVENGINES — caught live in e2e).
    expect(fastifyAdapter.stagedGeneration).toBe(true);
  });

  test("overlays a bun-native server entry listening on the plan port", () => {
    const files = fastifyAdapter.writeFiles?.(ctx) ?? [];
    expect(files.map((f) => f.path)).toEqual(["apps/api/src/server.ts"]);
    const server = files[0]?.contents ?? "";
    // Registers the generated autoload app plugin — .ts import rides the
    // template tsconfig's allowImportingTsExtensions.
    expect(server).toContain('import app from "./app.ts"');
    // The ` }` bound is the doctor's drift marker (see fastifyAdapter.doctor).
    expect(server).toContain("port: 3001 }");
    // The overlay must stay inside the generated dependency set — eject's
    // close-with-grace is NOT a dependency of the generated app.
    expect(server).not.toContain("close-with-grace");
    expect(fastifyServerTs(4000)).toContain("port: 4000 }");
  });
});

describe("elysia (direct-write — scaffold-flows.md#5)", () => {
  const ctx = ctxFor("elysia", {
    slot: "api",
    framework: "elysia",
    path: "apps/api",
    generator: null,
    port: 3001,
  });

  test("has no generator command", () => {
    expect(elysiaAdapter.command(ctx)).toBeNull();
  });

  test("writes the four documented files with the plan's port applied", () => {
    const files = elysiaAdapter.writeFiles?.(ctx) ?? [];
    expect(files.map((f) => f.path).sort()).toEqual([
      "apps/api/README.md",
      "apps/api/package.json",
      "apps/api/src/index.ts",
      "apps/api/tsconfig.json",
    ]);
    const indexTs = files.find((f) => f.path.endsWith("src/index.ts"));
    expect(indexTs?.contents).toContain(".listen(3001)");
    const packageJson = JSON.parse(
      files.find((f) => f.path.endsWith("package.json"))?.contents ?? "{}",
    );
    expect(packageJson.scripts.dev).toBe("bun --watch src/index.ts");
    expect(packageJson.scripts.build).toContain("--target bun");
    expect(packageJson.dependencies.elysia).toBeDefined();
    const tsconfig = JSON.parse(
      files.find((f) => f.path.endsWith("tsconfig.json"))?.contents ?? "{}",
    );
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });
});

describe("convex (direct-write + offline codegen — scaffold-flows.md#7)", () => {
  const ctx = ctxFor("convex", {
    slot: "backend",
    framework: "convex",
    path: "packages/backend",
    generator: null,
    port: null,
  });

  test("has no generator command", () => {
    expect(convexAdapter.command(ctx)).toBeNull();
  });

  test("names the package from the plan's namespace convention", () => {
    const files = convexAdapter.writeFiles?.(ctx) ?? [];
    const packageJson = JSON.parse(
      files.find((f) => f.path.endsWith("package.json"))?.contents ?? "{}",
    );
    expect(packageJson.name).toBe("@repo/backend");
    expect(packageJson.scripts.setup).toBe("convex dev --until-success");
    expect(packageJson.dependencies.convex).toBeDefined();
  });

  test("devDependencies satisfy the vendored tsconfig (types: [node] needs @types/node)", () => {
    // Regression guard for the v0.2.0 field bug: convex dev's typecheck failed
    // with TS2688 because the vendored tsconfig references node types but the
    // generated package.json omitted @types/node.
    const files = convexAdapter.writeFiles?.(ctx) ?? [];
    const tsconfig = files.find((f) => f.path.endsWith("convex/tsconfig.json"));
    const packageJson = JSON.parse(
      files.find((f) => f.path.endsWith("package.json"))?.contents ?? "{}",
    );
    if (tsconfig?.contents.includes('"node"')) {
      expect(packageJson.devDependencies["@types/node"]).toBeDefined();
    }
    expect(packageJson.devDependencies.typescript).toBeDefined();
  });

  test("writes schema, starter functions, env example, and defers login to the user", () => {
    const files = convexAdapter.writeFiles?.(ctx) ?? [];
    const paths = files.map((f) => f.path);
    expect(paths).toContain("packages/backend/convex/schema.ts");
    expect(paths).toContain("packages/backend/convex/messages.ts");
    expect(paths).toContain("packages/backend/convex/tsconfig.json");
    expect(paths).toContain("packages/backend/.env.example");
    const readme = files.find((f) => f.path.endsWith("README.md"));
    expect(readme?.contents).toContain("convex/_generated/api");
    expect(readme?.contents).toContain("convex dev --until-success");
  });

  test("ships the vendored _generated stubs wired to the starter module (no codegen command)", () => {
    // convex codegen ≥ 1.42 requires a configured deployment, so groot vendors
    // the standard stubs exactly like the official Convex templates do.
    expect(convexAdapter.postCommands).toBeUndefined();
    const files = convexAdapter.writeFiles?.(ctx) ?? [];
    const paths = files.map((f) => f.path);
    for (const stub of ["api.d.ts", "api.js", "dataModel.d.ts", "server.d.ts", "server.js"]) {
      expect(paths).toContain(`packages/backend/convex/_generated/${stub}`);
    }
    const apiDts = files.find((f) => f.path.endsWith("_generated/api.d.ts"));
    expect(apiDts?.contents).toContain('import type * as messages from "../messages.js"');
    expect(apiDts?.contents).not.toContain("myFunctions");
  });

  test("every written file carries bun-first guidance (no npm/npx/yarn/pnpm)", () => {
    // Guard for stub refreshes: upstream headers say `npx convex dev`; groot's
    // vendoring adapts them to `bunx` for its bun-first workspaces.
    const files = convexAdapter.writeFiles?.(ctx) ?? [];
    for (const file of files) {
      expect(file.contents).not.toMatch(/\b(npx|npm |yarn |pnpm )/);
    }
  });
});
