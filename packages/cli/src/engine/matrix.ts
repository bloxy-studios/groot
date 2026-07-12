/**
 * The scaffold option matrix — the single source of truth for what groot can grow.
 *
 * Ports and paths are normative (docs/architecture.md#port-allocation); generator
 * pins are normative (docs/scaffold-flows.md — update both together). Adapters
 * (src/adapters/, PR B of the engine series) key off `FrameworkMeta.id`.
 */
import type { FrameworkMeta, Slot } from "./types.ts";

export interface SlotSpec {
  /** Prompt title ("Web app?"). */
  readonly title: string;
  readonly choices: readonly FrameworkMeta[];
}

export const MATRIX: Record<Slot, SlotSpec> = {
  web: {
    title: "Web app",
    choices: [
      {
        id: "next",
        label: "Next.js",
        path: "apps/web",
        port: 3000,
        generator: "create-next-app@16",
      },
      { id: "sveltekit", label: "SvelteKit", path: "apps/web", port: 5173, generator: "sv@0.16" },
      // Port 3000 comes from the template's own dev script (`vite dev --port
      // 3000`) — same default as Next; the port-collision warning machinery
      // covers `add --path` coexistence, exactly like elysia/hono on 3001.
      {
        id: "tanstack-start",
        label: "TanStack Start",
        path: "apps/web",
        port: 3000,
        generator: "@tanstack/cli@0.69",
      },
      // 4321 is astro dev's built-in default — the only unique web port.
      { id: "astro", label: "Astro", path: "apps/web", port: 4321, generator: "create-astro@5" },
      // Vite default 5173, like SvelteKit — same-slot alternatives share ports
      // (the elysia/hono precedent); add --path coexistence rides the warning.
      {
        id: "react-router",
        label: "React Router",
        path: "apps/web",
        port: 5173,
        generator: "create-react-router@8",
      },
      // nuxt dev defaults to 3000 (shared with next/tanstack — same-slot rule).
      { id: "nuxt", label: "Nuxt", path: "apps/web", port: 3000, generator: "create-nuxt@3" },
      // Plain Vite SPA (react-ts template pinned); Vite default 5173.
      {
        id: "vite",
        label: "Vite (React)",
        path: "apps/web",
        port: 5173,
        generator: "create-vite@9",
      },
    ],
  },
  mobile: {
    title: "Mobile app",
    choices: [
      {
        id: "expo",
        label: "Expo",
        path: "apps/mobile",
        port: 8081,
        generator: "create-expo-app@4",
      },
    ],
  },
  desktop: {
    title: "Desktop app",
    choices: [
      // Port 1420 is the create-tauri-app template's own strictPort default,
      // referenced by tauri.conf.json's devUrl — unique in the matrix, kept.
      {
        id: "tauri",
        label: "Tauri",
        path: "apps/desktop",
        port: 1420,
        generator: "create-tauri-app@4",
      },
      // No declared port: electron-vite's renderer dev server is non-strict and
      // self-wiring (it launches Electron with whatever port it resolved), so
      // groot neither promises nor manages it — see docs/scaffold-flows.md#9.
      {
        id: "electron",
        label: "Electron",
        path: "apps/desktop",
        port: null,
        generator: "@quick-start/create-electron@1",
      },
    ],
  },
  api: {
    title: "API",
    choices: [
      // Elysia is written directly by groot (community generator diverges from
      // Elysia's own docs) — see docs/scaffold-flows.md#5.
      { id: "elysia", label: "Elysia", path: "apps/api", port: 3001, generator: null },
      { id: "hono", label: "Hono", path: "apps/api", port: 3001, generator: "create-hono@0.19" },
    ],
  },
  backend: {
    title: "Backend",
    choices: [
      // Convex files are written directly, including vendored _generated stubs
      // (codegen requires a configured deployment — see docs/scaffold-flows.md#7).
      { id: "convex", label: "Convex", path: "packages/backend", port: null, generator: null },
    ],
  },
};

/** Prompt/display order of slots. */
export const SLOT_ORDER: readonly Slot[] = ["web", "mobile", "desktop", "api", "backend"];

/**
 * Defaults applied by `--yes` for slots the user didn't pick — groot's flagship
 * pairing (docs/cli-spec.md#defaults): a Next.js app wired to a Convex backend.
 */
export const YES_DEFAULTS: Record<Slot, string> = {
  web: "next",
  mobile: "none",
  desktop: "none",
  api: "none",
  backend: "convex",
};

/** Look up a framework choice within a slot; undefined when the id isn't offered there. */
export function findChoice(slot: Slot, id: string): FrameworkMeta | undefined {
  return MATRIX[slot].choices.find((choice) => choice.id === id);
}

/** Valid flag values for a slot, including "none". */
export function choiceIdsFor(slot: Slot): string[] {
  return [...MATRIX[slot].choices.map((choice) => choice.id), "none"];
}
