import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { applyPresetSelections, loadPreset } from "./preset.ts";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION, type PlannedScaffold, type Slot } from "./types.ts";

function manifestWith(scaffolds: PlannedScaffold[]): string {
  return `${JSON.stringify(
    {
      $schema: MANIFEST_SCHEMA_URL,
      version: MANIFEST_VERSION,
      createdWith: "create-groot@0.3.0",
      conventions: { packagesNamespace: "@repo" },
      scaffolds,
    },
    null,
    2,
  )}\n`;
}

const WEB_NEXT: PlannedScaffold = {
  slot: "web",
  framework: "next",
  path: "apps/web",
  generator: "create-next-app@16",
  port: 3000,
};
const WEB_SVELTE_MARKETING: PlannedScaffold = {
  slot: "web",
  framework: "sveltekit",
  path: "apps/marketing",
  generator: "sv@0.16",
  port: 5173,
};
const API_ELYSIA: PlannedScaffold = {
  slot: "api",
  framework: "elysia",
  path: "apps/api",
  generator: null,
  port: 3001,
};
const BACKEND_CONVEX: PlannedScaffold = {
  slot: "backend",
  framework: "convex",
  path: "packages/backend",
  generator: null,
  port: null,
};

async function presetFile(scaffolds: PlannedScaffold[]): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "groot-preset-"));
  const file = join(dir, "groot.json");
  await writeFile(file, manifestWith(scaffolds));
  return { dir, file };
}

async function expectUsage(fn: () => Promise<unknown>, fragment: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GrootError);
    expect((error as GrootError).exitCode).toBe(EXIT.USAGE);
    expect((error as GrootError).message).toContain(fragment);
    return;
  }
  throw new Error(`expected a GrootError containing "${fragment}"`);
}

describe("loadPreset", () => {
  test("reads slot selections from a manifest file; absent slots become none", async () => {
    const { file } = await presetFile([WEB_NEXT, API_ELYSIA, BACKEND_CONVEX]);
    const preset = await loadPreset(file);
    expect(preset.selections).toEqual({
      web: "next",
      mobile: "none",
      desktop: "none",
      api: "elysia",
      backend: "convex",
    });
    expect(preset.warnings).toEqual([]);
    expect(preset.path).toBe(file);
  });

  test("accepts a workspace directory containing a groot.json", async () => {
    const { dir, file } = await presetFile([WEB_NEXT]);
    const preset = await loadPreset(dir);
    expect(preset.path).toBe(file);
    expect(preset.selections.web).toBe("next");
    expect(preset.selections.backend).toBe("none");
  });

  test("an empty scaffold list means every slot is none (bare trunk)", async () => {
    const { file } = await presetFile([]);
    const preset = await loadPreset(file);
    expect(Object.values(preset.selections)).toEqual(["none", "none", "none", "none", "none"]);
  });

  test("multiple scaffolds in one slot: first wins, the rest become a warning", async () => {
    const { file } = await presetFile([WEB_NEXT, WEB_SVELTE_MARKETING, API_ELYSIA]);
    const preset = await loadPreset(file);
    expect(preset.selections.web).toBe("next");
    expect(preset.warnings).toHaveLength(1);
    expect(preset.warnings.at(0)).toContain("2 web scaffolds");
    expect(preset.warnings.at(0)).toContain("groot add --path");
  });

  test("missing path → EXIT.USAGE", async () => {
    await expectUsage(() => loadPreset("/definitely/not/here"), "Preset not found");
  });

  test("directory without a groot.json → EXIT.USAGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "groot-preset-empty-"));
    await expectUsage(() => loadPreset(dir), "not readable JSON");
  });

  test("unparseable JSON → EXIT.USAGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "groot-preset-bad-"));
    const file = join(dir, "groot.json");
    await writeFile(file, "{ not json");
    await expectUsage(() => loadPreset(file), "not readable JSON");
  });

  test("unsupported manifest version → EXIT.USAGE via manifest validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "groot-preset-ver-"));
    const file = join(dir, "groot.json");
    await writeFile(file, JSON.stringify({ version: 99, createdWith: "create-groot@9.9.9" }));
    await expectUsage(() => loadPreset(file), "unsupported manifest version");
  });

  test("a framework this CLI doesn't know → EXIT.USAGE via manifest validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "groot-preset-fw-"));
    const file = join(dir, "groot.json");
    await writeFile(
      file,
      manifestWith([{ ...WEB_NEXT, framework: "angular" as PlannedScaffold["framework"] }]),
    );
    await expectUsage(() => loadPreset(file), "not a known web framework");
  });
});

describe("applyPresetSelections", () => {
  const preset: Record<Slot, string> = {
    web: "next",
    mobile: "none",
    desktop: "none",
    api: "elysia",
    backend: "convex",
  };

  test("fills every undecided slot from the preset", () => {
    expect(applyPresetSelections({}, preset)).toEqual(preset);
  });

  test("explicit slot flags win over the preset — including explicit none", () => {
    const merged = applyPresetSelections({ web: "sveltekit", backend: "none" }, preset);
    expect(merged).toEqual({
      web: "sveltekit",
      mobile: "none",
      desktop: "none",
      api: "elysia",
      backend: "none",
    });
  });
});
