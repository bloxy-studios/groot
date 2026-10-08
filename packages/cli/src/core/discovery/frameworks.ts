/**
 * Framework → unit-kind rules, read from declared dependencies only.
 *
 * Order matters: wrappers win over what they wrap (Tauri and Electron apps
 * contain a Vite/React frontend; Expo contains React Native), and app
 * frameworks win over libraries they happen to depend on (a Next.js app that
 * uses Hono route handlers is a web app; a web app depending on `convex` is a
 * Convex *client*, not the backend). Framework ids use Groot's own
 * vocabulary (contracts/blueprint.ts FRAMEWORK_IDS) plus the API frameworks
 * discovery also recognizes, so recipes can target them directly.
 */
import type { UnitKind } from "../contracts/common.ts";

export interface FrameworkRule {
  readonly id: string;
  readonly kind: UnitKind;
  /** Every one of these packages must be declared. */
  readonly all?: readonly string[];
  /** At least one of these packages must be declared. */
  readonly any?: readonly string[];
  /**
   * The runtime the framework's own tooling runs on regardless of the
   * package manager (its CLI has a node shebang), unless a script opts into
   * Bun explicitly with `--bun`. null: decided by the unit's scripts.
   */
  readonly runtime: "node" | null;
}

export const APP_FRAMEWORKS: readonly FrameworkRule[] = [
  { id: "tauri", kind: "desktop", any: ["@tauri-apps/cli", "@tauri-apps/api"], runtime: "node" },
  { id: "electron", kind: "desktop", any: ["electron"], runtime: "node" },
  { id: "expo", kind: "mobile", any: ["expo"], runtime: "node" },
  { id: "react-native", kind: "mobile", any: ["react-native"], runtime: "node" },
  { id: "next", kind: "web", any: ["next"], runtime: "node" },
  { id: "sveltekit", kind: "web", any: ["@sveltejs/kit"], runtime: "node" },
  { id: "astro", kind: "web", any: ["astro"], runtime: "node" },
  { id: "nuxt", kind: "web", any: ["nuxt"], runtime: "node" },
  { id: "tanstack-start", kind: "web", any: ["@tanstack/react-start"], runtime: "node" },
  { id: "react-router", kind: "web", all: ["react-router", "@react-router/dev"], runtime: "node" },
  { id: "vite", kind: "web", all: ["vite"], any: ["react", "vue"], runtime: "node" },
  { id: "nestjs", kind: "api", any: ["@nestjs/core"], runtime: "node" },
  { id: "hono", kind: "api", any: ["hono"], runtime: null },
  { id: "elysia", kind: "api", any: ["elysia"], runtime: null },
  { id: "fastify", kind: "api", any: ["fastify"], runtime: null },
  { id: "express", kind: "api", any: ["express"], runtime: null },
  { id: "koa", kind: "api", any: ["koa"], runtime: null },
];

export const BACKEND_FRAMEWORKS: readonly FrameworkRule[] = [
  { id: "convex", kind: "backend", any: ["convex"], runtime: "node" },
  { id: "supabase", kind: "backend", any: ["supabase"], runtime: null },
];

/** Packages that evidence each framework id (blueprint ↔ observation contradiction checks). */
export const FRAMEWORK_PACKAGES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [...APP_FRAMEWORKS, ...BACKEND_FRAMEWORKS].map((rule) => [
    rule.id,
    [...(rule.all ?? []), ...(rule.any ?? [])].filter((name) => !["react", "vue"].includes(name)),
  ]),
);

export interface FrameworkMatch {
  readonly rule: FrameworkRule;
  /** The package whose declaration identifies the framework. */
  readonly evidence: string;
  /** Its declared version range. */
  readonly version: string;
}

/** First rule whose packages are all declared. */
export function matchFramework(
  rules: readonly FrameworkRule[],
  declared: Readonly<Record<string, string>>,
): FrameworkMatch | null {
  for (const rule of rules) {
    const all = rule.all ?? [];
    if (!all.every((name) => name in declared)) continue;
    const any = rule.any ?? [];
    const anyHit = any.find((name) => name in declared);
    if (any.length > 0 && anyHit === undefined) continue;
    const evidence = all[0] ?? (anyHit as string);
    return { rule, evidence, version: declared[evidence] as string };
  }
  return null;
}

/** Shared config presets (`@repo/typescript-config`, `eslint-config-acme`, `tailwind-config`). */
export function isConfigPackage(packageName: string | null, path: string): boolean {
  const base = (packageName ?? "").replace(/^@[^/]+\//, "");
  const dir = path.split("/").pop() ?? "";
  return [base, dir].some(
    (name) => /(?:^|-)config$/.test(name) || /^(?:eslint|prettier)-config-/.test(name),
  );
}
