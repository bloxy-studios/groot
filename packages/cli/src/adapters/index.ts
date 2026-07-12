/**
 * Adapter registry. The trunk (create-turbo) is not a slot adapter — the
 * generate stage always plants it first (see ./trunk.ts).
 */
import type { ScaffoldAdapter } from "../engine/adapter.ts";
import type { FrameworkId } from "../engine/types.ts";
import { convexAdapter } from "./convex.ts";
import { electronAdapter } from "./electron.ts";
import { elysiaAdapter } from "./elysia.ts";
import { expoAdapter } from "./expo.ts";
import { honoAdapter } from "./hono.ts";
import { nextAdapter } from "./next.ts";
import { sveltekitAdapter } from "./sveltekit.ts";
import { tauriAdapter } from "./tauri.ts";

export const ADAPTERS: Record<FrameworkId, ScaffoldAdapter> = {
  next: nextAdapter,
  sveltekit: sveltekitAdapter,
  expo: expoAdapter,
  tauri: tauriAdapter,
  electron: electronAdapter,
  elysia: elysiaAdapter,
  hono: honoAdapter,
  convex: convexAdapter,
};
