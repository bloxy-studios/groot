/**
 * Environment variable NAMES a frontend reads for the workspace backend —
 * shared by the stitch stage (.env.example placeholders) and the v2 blueprint
 * bridge (environment contracts). Values are never part of this module.
 */
import type { FrameworkId, PlannedScaffold } from "./types.ts";

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
  astro: "PUBLIC_CONVEX_URL=", // import.meta.env.PUBLIC_* — Astro's client prefix
  "react-router": "VITE_CONVEX_URL=", // framework mode is Vite-based
  nuxt: "NUXT_PUBLIC_CONVEX_URL=", // runtimeConfig.public via NUXT_PUBLIC_*
  vite: "VITE_CONVEX_URL=",
};

/**
 * Mobile counterpart: Expo exposes EXPO_PUBLIC_* to the app at build time;
 * bare React Native ships no public-env mechanism, so it gets the plain
 * CONVEX_URL= placeholder (users wire it via their env lib of choice).
 * Exact-line membership below keeps it from being swallowed by the longer
 * *_CONVEX_URL= names it is a substring of.
 */
const CONVEX_URL_ENV_BY_MOBILE_FRAMEWORK: Partial<Record<FrameworkId, string>> = {
  expo: "EXPO_PUBLIC_CONVEX_URL=",
  "react-native": "CONVEX_URL=",
};

/**
 * Supabase clients need TWO values (URL + anon key) and every quickstart
 * prefixes both with the same client-exposure mechanism — so this maps
 * framework → prefix rather than full lines. Same sources as the Convex
 * naming above (Next exposes NEXT_PUBLIC_*, SvelteKit/Astro PUBLIC_*,
 * Vite-based frameworks VITE_*, Nuxt runtimeConfig.public via NUXT_PUBLIC_*,
 * Expo EXPO_PUBLIC_*; bare React Native has no public-env mechanism → no
 * prefix, like its CONVEX_URL= line).
 */
const SUPABASE_ENV_PREFIX_BY_FRAMEWORK: Partial<Record<FrameworkId, string>> = {
  next: "NEXT_PUBLIC_",
  sveltekit: "PUBLIC_",
  "tanstack-start": "VITE_",
  astro: "PUBLIC_",
  "react-router": "VITE_",
  nuxt: "NUXT_PUBLIC_",
  vite: "VITE_",
  expo: "EXPO_PUBLIC_",
  "react-native": "",
};

/** The `.env.example` lines a frontend needs for the workspace's backend. */
export function backendEnvLines(
  backendFramework: FrameworkId,
  scaffold: Pick<PlannedScaffold, "slot" | "framework">,
): string[] {
  if (backendFramework === "supabase") {
    const prefix =
      SUPABASE_ENV_PREFIX_BY_FRAMEWORK[scaffold.framework] ??
      (scaffold.slot === "web" ? "VITE_" : "EXPO_PUBLIC_");
    return [`${prefix}SUPABASE_URL=`, `${prefix}SUPABASE_ANON_KEY=`];
  }
  return [
    scaffold.slot === "web"
      ? (CONVEX_URL_ENV_BY_WEB_FRAMEWORK[scaffold.framework] ?? "VITE_CONVEX_URL=")
      : (CONVEX_URL_ENV_BY_MOBILE_FRAMEWORK[scaffold.framework] ?? "EXPO_PUBLIC_CONVEX_URL="),
  ];
}
