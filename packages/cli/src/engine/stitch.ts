/**
 * Stitch stage (docs/architecture.md#4-stitch): the deterministic patch set that
 * turns N independent scaffolds into one coherent bun workspace. Every operation
 * is idempotent — re-running a stitch over its own output is safe.
 *
 * Failures throw EXIT.STITCH and leave the tree in place for inspection.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { planToManifest } from "./plan.ts";
import type { FrameworkId, Plan } from "./types.ts";

/** Lockfiles a generator may have left inside its scaffold directory. */
const NESTED_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new GrootError(
      `Stitch failed: could not parse ${path} (${error instanceof Error ? error.message : String(error)})`,
      EXIT.STITCH,
    );
  }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Root package.json: workspace name, private, workspace globs. */
export async function stitchRootIdentity(plan: Plan): Promise<string> {
  const path = join(plan.targetDir, "package.json");
  const pkg = await readJson(path);
  pkg.name = plan.name;
  pkg.private = true;
  const workspaces = Array.isArray(pkg.workspaces) ? (pkg.workspaces as string[]) : [];
  for (const glob of ["apps/*", "packages/*"]) {
    if (!workspaces.includes(glob)) workspaces.push(glob);
  }
  pkg.workspaces = workspaces;
  await writeJson(path, pkg);
  return `root package.json → name "${plan.name}", workspaces [${workspaces.join(", ")}]`;
}

/**
 * Apps get bare names from their directory basename ("web", "mobile", "api") —
 * generators disagree wildly (sv uses the full path argument, which isn't even a
 * valid package name). The backend keeps its @repo/* name from its adapter.
 */
export async function stitchAppNames(plan: Plan): Promise<string[]> {
  const notes: string[] = [];
  for (const scaffold of plan.scaffolds) {
    if (!scaffold.path.startsWith("apps/")) continue;
    const path = join(plan.targetDir, scaffold.path, "package.json");
    if (!existsSync(path)) continue;
    const pkg = await readJson(path);
    const name = basename(scaffold.path);
    if (pkg.name !== name) {
      pkg.name = name;
      pkg.private = true;
      await writeJson(path, pkg);
      notes.push(`${scaffold.path}/package.json → name "${name}"`);
    }
  }
  return notes;
}

/** Exactly one lockfile per workspace: the root one (written by verify's install). */
export async function stitchLockfileHygiene(plan: Plan): Promise<string[]> {
  const notes: string[] = [];
  for (const scaffold of plan.scaffolds) {
    for (const lockfile of NESTED_LOCKFILES) {
      const path = join(plan.targetDir, scaffold.path, lockfile);
      if (existsSync(path)) {
        await rm(path, { force: true });
        notes.push(`removed nested ${scaffold.path}/${lockfile}`);
      }
    }
  }
  return notes;
}

/**
 * Hono's bun template exports the app directly, which Bun serves on port 3000 —
 * colliding with Next.js. Rewrite each hono scaffold to its assigned port —
 * `groot add --path` can grow a second one. (Elysia's port is written correctly
 * at generation time; Next/Vite/Metro keep their defaults.)
 */
export async function stitchHonoPort(plan: Plan): Promise<string[]> {
  const notes: string[] = [];
  for (const hono of plan.scaffolds) {
    if (hono.framework !== "hono" || hono.port === null) continue;
    const path = join(plan.targetDir, hono.path, "src/index.ts");
    if (!existsSync(path)) continue;
    const source = await readFile(path, "utf8");
    const marker = "export default app";
    if (!source.includes(marker)) {
      // Upstream template changed shape — or a previous stitch already rewrote
      // this file. Leave it alone rather than corrupting it.
      notes.push(
        `${hono.path}/src/index.ts: default-export marker not found; port rewrite skipped`,
      );
      continue;
    }
    const rewritten = source.replace(
      marker,
      `export default {\n  port: ${hono.port},\n  fetch: app.fetch,\n}`,
    );
    await writeFile(path, rewritten, "utf8");
    notes.push(`${hono.path}/src/index.ts → dev port ${hono.port}`);
  }
  return notes;
}

/**
 * The client-exposed env var each web framework actually reads — Next.js only
 * exposes NEXT_PUBLIC_*, SvelteKit's $env/static/public requires PUBLIC_*, and
 * Vite-based frameworks (TanStack Start) expose VITE_*. Matches each
 * framework's Convex quickstart naming.
 */
const CONVEX_URL_ENV_BY_WEB_FRAMEWORK: Partial<Record<FrameworkId, string>> = {
  next: "NEXT_PUBLIC_CONVEX_URL=",
  sveltekit: "PUBLIC_CONVEX_URL=",
  "tanstack-start": "VITE_CONVEX_URL=",
};

/**
 * Wire frontends to the Convex backend: workspace dependency + env placeholders
 * (docs/architecture.md — consumption via deep imports of convex/_generated).
 */
export async function stitchBackendLinks(plan: Plan): Promise<string[]> {
  const backend = plan.scaffolds.find((s) => s.slot === "backend");
  if (backend === undefined) return [];
  const backendName = `${plan.conventions.packagesNamespace}/backend`;
  const notes: string[] = [];

  const envLines: string[] = [];
  for (const scaffold of plan.scaffolds) {
    if (scaffold.slot !== "web" && scaffold.slot !== "mobile") continue;
    const path = join(plan.targetDir, scaffold.path, "package.json");
    if (!existsSync(path)) continue;
    const pkg = await readJson(path);
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    if (deps[backendName] !== "workspace:*") {
      deps[backendName] = "workspace:*";
      pkg.dependencies = deps;
      await writeJson(path, pkg);
      notes.push(`${scaffold.path} → depends on ${backendName} (workspace:*)`);
    }
    envLines.push(
      scaffold.slot === "web"
        ? (CONVEX_URL_ENV_BY_WEB_FRAMEWORK[scaffold.framework] ?? "VITE_CONVEX_URL=")
        : "EXPO_PUBLIC_CONVEX_URL=",
    );
  }

  if (envLines.length > 0) {
    const envPath = join(plan.targetDir, ".env.example");
    const header =
      "# Convex deployment URL — written to packages/backend/.env.local by `bun run setup`.\n";
    const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
    const missing = envLines.filter((line) => !existing.includes(line));
    if (missing.length > 0) {
      await appendFile(envPath, `${existing.length > 0 ? "\n" : header}${missing.join("\n")}\n`);
      notes.push(`.env.example → ${missing.join(", ")}`);
    }
  }
  return notes;
}

/** Build outputs per selected framework so turbo caching works out of the box. */
export async function stitchTurboOutputs(plan: Plan): Promise<string | null> {
  const path = join(plan.targetDir, "turbo.json");
  if (!existsSync(path)) return null;
  const turbo = await readJson(path);
  const tasks = (turbo.tasks ?? {}) as Record<string, Record<string, unknown>>;
  const build = tasks.build ?? { dependsOn: ["^build"] };

  const outputs = new Set<string>(Array.isArray(build.outputs) ? (build.outputs as string[]) : []);
  const frameworks = new Set(plan.scaffolds.map((s) => s.framework));
  if (frameworks.has("next")) {
    outputs.add(".next/**");
    outputs.add("!.next/cache/**");
  }
  if (frameworks.has("sveltekit")) outputs.add(".svelte-kit/**");
  // Tauri's `build` is the Vite frontend build (dist/); the Rust build lives in
  // src-tauri/target (cargo-managed, never a turbo output). TanStack Start's
  // 1.x template is plain `vite build` → dist/ (no Nitro .output).
  if (
    frameworks.has("elysia") ||
    frameworks.has("hono") ||
    frameworks.has("tauri") ||
    frameworks.has("tanstack-start")
  ) {
    outputs.add("dist/**");
  }
  // electron-vite builds main/preload/renderer into out/.
  if (frameworks.has("electron")) outputs.add("out/**");

  build.outputs = [...outputs];
  tasks.build = build;
  turbo.tasks = tasks;
  await writeJson(path, turbo);
  return `turbo.json → build.outputs [${[...outputs].join(", ")}]`;
}

/**
 * Bun runs dependency lifecycle scripts only for trusted packages, and
 * electron's runtime download is a postinstall script that is NOT on bun's
 * default-trusted list (verified empirically: the flagship E2E's real
 * `bun install` left node_modules/electron/dist missing until this landed).
 * Workspaces with an electron scaffold get it added to the root
 * trustedDependencies so the verify-stage install produces a runnable app.
 *
 * Note: bun treats an explicit trustedDependencies as replacing its default
 * allowlist — a deliberate tradeoff here. Packages a user later adds that need
 * their own postinstalls belong in this same array; doctor's electron-binary
 * check points at `bun pm trust` for exactly that discovery flow.
 */
export async function stitchTrustedDependencies(plan: Plan): Promise<string | null> {
  if (!plan.scaffolds.some((scaffold) => scaffold.framework === "electron")) return null;
  const path = join(plan.targetDir, "package.json");
  const pkg = await readJson(path);
  const trusted = new Set<string>(
    Array.isArray(pkg.trustedDependencies) ? (pkg.trustedDependencies as string[]) : [],
  );
  if (trusted.has("electron")) return null;
  trusted.add("electron");
  pkg.trustedDependencies = [...trusted];
  await writeJson(path, pkg);
  return "root package.json → trustedDependencies [electron] (bun runs its postinstall)";
}

/** Root .gitignore must cover the workspace basics regardless of what the trunk shipped. */
export async function stitchRootGitignore(plan: Plan): Promise<string | null> {
  const path = join(plan.targetDir, ".gitignore");
  const required = ["node_modules", ".turbo", ".env", ".env.*", "!.env.example"];
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const lines = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = required.filter((entry) => !lines.has(entry) && !lines.has(`${entry}/`));
  if (missing.length === 0) return null;
  await appendFile(
    path,
    `${existing.endsWith("\n") || existing === "" ? "" : "\n"}\n# groot\n${missing.join("\n")}\n`,
  );
  return `.gitignore → added ${missing.join(", ")}`;
}

/** groot.json — the manifest add/doctor consume (docs/cli-spec.md#grootjson-manifest). */
export async function stitchManifest(plan: Plan): Promise<string> {
  const path = join(plan.targetDir, "groot.json");
  await writeFile(path, `${JSON.stringify(planToManifest(plan), null, 2)}\n`, "utf8");
  return "groot.json written";
}

export interface StitchOptions {
  /** Progress callback — receives a human label as each operation lands. */
  readonly onStep?: (label: string) => void;
}

/** Run every stitch operation in order. Returns the applied-operation notes. */
export async function stitch(plan: Plan, options: StitchOptions = {}): Promise<string[]> {
  const report = options.onStep ?? (() => {});
  report("Stitching workspace");
  const notes: string[] = [];
  const push = (note: string | string[] | null): void => {
    if (note === null) return;
    if (Array.isArray(note)) notes.push(...note);
    else notes.push(note);
  };

  push(await stitchAppNames(plan));
  push(await stitchLockfileHygiene(plan));
  push(await stitchHonoPort(plan));
  push(await stitchBackendLinks(plan));
  push(await stitchTurboOutputs(plan));
  push(await stitchRootIdentity(plan));
  push(await stitchTrustedDependencies(plan));
  push(await stitchRootGitignore(plan));
  push(await stitchManifest(plan));
  return notes;
}
