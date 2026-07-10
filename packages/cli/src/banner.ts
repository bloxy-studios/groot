import pc from "picocolors";
import { MATRIX, SLOT_ORDER } from "./engine/matrix.ts";

/** Display view of the scaffold matrix, derived from the engine's source of truth. */
export const SCAFFOLD_SLOTS = SLOT_ORDER.map((slot) => ({
  slot,
  options: MATRIX[slot].choices.map((choice) => choice.label),
}));

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
