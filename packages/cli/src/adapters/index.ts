/**
 * Adapter registry. The trunk (create-turbo) is not a slot adapter — the
 * generate stage always plants it first (see ./trunk.ts).
 */
import type { ScaffoldAdapter } from "../engine/adapter.ts";
import type { FrameworkId } from "../engine/types.ts";
import { astroAdapter } from "./astro.ts";
import { convexAdapter } from "./convex.ts";
import { electronAdapter } from "./electron.ts";
import { elysiaAdapter } from "./elysia.ts";
import { expoAdapter } from "./expo.ts";
import { fastifyAdapter } from "./fastify.ts";
import { honoAdapter } from "./hono.ts";
import { nextAdapter } from "./next.ts";
import { nuxtAdapter } from "./nuxt.ts";
import { reactNativeAdapter } from "./react-native.ts";
import { reactRouterAdapter } from "./react-router.ts";
import { supabaseAdapter } from "./supabase.ts";
import { sveltekitAdapter } from "./sveltekit.ts";
import { tanstackStartAdapter } from "./tanstack-start.ts";
import { tauriAdapter } from "./tauri.ts";
import { viteAdapter } from "./vite.ts";

export const ADAPTERS: Record<FrameworkId, ScaffoldAdapter> = {
  next: nextAdapter,
  sveltekit: sveltekitAdapter,
  "tanstack-start": tanstackStartAdapter,
  astro: astroAdapter,
  "react-router": reactRouterAdapter,
  nuxt: nuxtAdapter,
  vite: viteAdapter,
  expo: expoAdapter,
  "react-native": reactNativeAdapter,
  tauri: tauriAdapter,
  electron: electronAdapter,
  elysia: elysiaAdapter,
  hono: honoAdapter,
  fastify: fastifyAdapter,
  convex: convexAdapter,
  supabase: supabaseAdapter,
};
