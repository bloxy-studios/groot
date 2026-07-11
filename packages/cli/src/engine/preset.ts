/**
 * Preset support (docs/cli-spec.md#presets): `groot init --preset <path>` reads
 * an existing groot.json — a file, or a workspace directory containing one — as
 * the **selections source**. Only the slot → framework shape is read; workspace
 * name, paths, ports, generator pins, conventions, and provenance always come
 * from the current CLI's matrix, so a preset written by an older groot never
 * pins stale generators.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { validateManifest } from "./manifest.ts";
import { SLOT_ORDER } from "./matrix.ts";
import type { SlotSelections } from "./plan.ts";
import { NONE, type Slot } from "./types.ts";

export interface PresetResolution {
  /** A complete decision for every slot: a framework id, or "none" for absent slots. */
  readonly selections: Record<Slot, string>;
  /** Non-fatal findings (extra same-slot scaffolds a preset can't replicate). */
  readonly warnings: readonly string[];
  /** The groot.json file the preset was read from (for progress output). */
  readonly path: string;
}

/** Resolve `--preset` input to a groot.json path — accepts the file or its directory. */
async function presetFilePath(input: string): Promise<string> {
  try {
    const info = await stat(input);
    return info.isDirectory() ? join(input, "groot.json") : input;
  } catch {
    throw new GrootError(
      `Preset not found: ${input}`,
      EXIT.USAGE,
      "Pass a groot.json file, or a groot workspace directory containing one.",
    );
  }
}

/**
 * Load a preset manifest and project it onto the four slots. The manifest is
 * validated exactly like a workspace manifest, so a framework this CLI version
 * doesn't know is rejected with a precise error. When `groot add --path` grew
 * multiple scaffolds into one slot, the first one wins and the rest are
 * surfaced as warnings — replicate them with `groot add --path` afterwards.
 */
export async function loadPreset(input: string): Promise<PresetResolution> {
  const path = await presetFilePath(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new GrootError(
      `Preset ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.USAGE,
      "A preset is a groot.json manifest, written by `groot init` and updated by `groot add`.",
    );
  }
  const manifest = validateManifest(parsed, path);

  const selections = {} as Record<Slot, string>;
  const warnings: string[] = [];
  for (const slot of SLOT_ORDER) {
    const owners = manifest.scaffolds.filter((scaffold) => scaffold.slot === slot);
    const first = owners.at(0);
    selections[slot] = first?.framework ?? NONE;
    if (owners.length > 1 && first !== undefined) {
      warnings.push(
        `preset has ${owners.length} ${slot} scaffolds — using "${first.framework}" (${first.path}); grow the others afterwards with \`groot add --path\`.`,
      );
    }
  }
  return { selections, warnings, path };
}

/**
 * Fill undecided slots from a preset. Explicit slot flags always win — a preset
 * is a default, not an override (docs/cli-spec.md#presets).
 */
export function applyPresetSelections(
  selections: SlotSelections,
  preset: Record<Slot, string>,
): Record<Slot, string> {
  const resolved = {} as Record<Slot, string>;
  for (const slot of SLOT_ORDER) {
    resolved[slot] = selections[slot] ?? preset[slot];
  }
  return resolved;
}
