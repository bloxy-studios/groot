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
export const SLOT_ORDER: readonly Slot[] = ["web", "mobile", "api", "backend"];

/**
 * Defaults applied by `--yes` for slots the user didn't pick — groot's flagship
 * pairing (docs/cli-spec.md#defaults): a Next.js app wired to a Convex backend.
 */
export const YES_DEFAULTS: Record<Slot, string> = {
  web: "next",
  mobile: "none",
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
