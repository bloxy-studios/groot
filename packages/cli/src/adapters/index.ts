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
import { honoAdapter } from "./hono.ts";
import { nextAdapter } from "./next.ts";
import { reactRouterAdapter } from "./react-router.ts";
import { sveltekitAdapter } from "./sveltekit.ts";
import { tanstackStartAdapter } from "./tanstack-start.ts";
import { tauriAdapter } from "./tauri.ts";

export const ADAPTERS: Record<FrameworkId, ScaffoldAdapter> = {
  next: nextAdapter,
  sveltekit: sveltekitAdapter,
  "tanstack-start": tanstackStartAdapter,
  astro: astroAdapter,
  "react-router": reactRouterAdapter,
  expo: expoAdapter,
  tauri: tauriAdapter,
  electron: electronAdapter,
  elysia: elysiaAdapter,
  hono: honoAdapter,
  convex: convexAdapter,
};
