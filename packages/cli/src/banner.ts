import pc from "picocolors";

/** Scaffold slots groot will grow, in display order. Shared by banner and (soon) prompts. */
export const SCAFFOLD_SLOTS = [
  { slot: "web", options: ["Next.js", "SvelteKit"] },
  { slot: "mobile", options: ["Expo"] },
  { slot: "api", options: ["Elysia", "Hono"] },
  { slot: "backend", options: ["Convex"] },
] as const;

/** Plain-text banner (no colors) — used by tests and non-TTY output. */
export function bannerText(version: string): string {
  return `🌱 groot v${version} — plant a bun-first Turborepo and grow it.`;
}

/** Colored banner for TTY output. */
export function banner(version: string): string {
  return pc.green(pc.bold(bannerText(version)));
}

/** One-line summary of the scaffold matrix, e.g. for --help epilogue. */
export function scaffoldMatrixSummary(): string {
  return SCAFFOLD_SLOTS.map(({ slot, options }) => `${slot}: ${options.join(" | ")}`).join(" · ");
}
