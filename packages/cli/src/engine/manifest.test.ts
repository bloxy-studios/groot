import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { findWorkspaceRoot, loadManifest, saveManifest, validateManifest } from "./manifest.ts";
import { MANIFEST_SCHEMA_URL } from "./types.ts";

const VALID = {
  $schema: MANIFEST_SCHEMA_URL,
  version: 1,
  createdWith: "create-groot@0.2.1",
  conventions: { packagesNamespace: "@repo" },
  scaffolds: [
    {
      slot: "web",
      framework: "next",
      path: "apps/web",
      generator: "create-next-app@16",
      port: 3000,
    },
  ],
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "groot-manifest-"));
}

describe("validateManifest", () => {
  test("accepts a valid manifest", () => {
    expect(() => validateManifest(structuredClone(VALID), "groot.json")).not.toThrow();
  });

  test("rejects wrong version, malformed createdWith, and unknown frameworks", () => {
    for (const broken of [
      { ...structuredClone(VALID), version: 2 },
      { ...structuredClone(VALID), createdWith: "something-else@1.0.0" },
      {
        ...structuredClone(VALID),
        scaffolds: [
          { slot: "web", framework: "angular", path: "apps/web", generator: null, port: 3000 },
        ],
      },
      { ...structuredClone(VALID), conventions: {} },
      { ...structuredClone(VALID), conventions: null }, // typeof null === "object" — must be a usage error, not a TypeError
      { ...structuredClone(VALID), conventions: ["@repo"] },
      { ...structuredClone(VALID), scaffolds: [null] }, // non-object entry must be a usage error, not a TypeError
      { ...structuredClone(VALID), scaffolds: ["apps/web"] },
      "not an object",
    ]) {
      try {
        validateManifest(broken, "groot.json");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GrootError);
        expect((error as GrootError).exitCode).toBe(EXIT.USAGE);
      }
    }
  });

  test("rejects frameworks assigned to the wrong slot", () => {
    const broken = {
      ...structuredClone(VALID),
      scaffolds: [
        { slot: "api", framework: "next", path: "apps/api", generator: null, port: 3001 },
      ],
    };
    expect(() => validateManifest(broken, "groot.json")).toThrow(GrootError);
  });

  test("rejects malformed generator and port fields (schema parity)", () => {
    const scaffold = (overrides: Record<string, unknown>) => ({
      ...structuredClone(VALID),
      scaffolds: [
        {
          slot: "web",
          framework: "next",
          path: "apps/web",
          generator: "create-next-app@16",
          port: 3000,
          ...overrides,
        },
      ],
    });
    for (const broken of [
      scaffold({ port: "3000" }), // string port
      scaffold({ port: 3.5 }), // non-integer
      scaffold({ port: 0 }), // out of range
      scaffold({ port: 70000 }), // out of range
      scaffold({ port: undefined }), // missing
      scaffold({ generator: 16 }), // non-string, non-null
      scaffold({ generator: undefined }), // missing
    ]) {
      expect(() => validateManifest(broken, "groot.json")).toThrow(GrootError);
    }
    // null is valid for both (direct-write scaffolds, portless backends).
    expect(() =>
      validateManifest(scaffold({ generator: null, port: null }), "groot.json"),
    ).not.toThrow();
  });
});

describe("workspace discovery", () => {
  test("findWorkspaceRoot walks up from nested directories", async () => {
    const base = await scratch();
    await writeFile(join(base, "groot.json"), JSON.stringify(VALID));
    const nested = join(base, "apps", "web", "src");
    await mkdir(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(base);
    expect(findWorkspaceRoot(base)).toBe(base);
  });

  test("loadManifest errors with EXIT.USAGE outside any workspace", async () => {
    const base = await scratch();
    try {
      await loadManifest(base);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      expect((error as GrootError).exitCode).toBe(EXIT.USAGE);
      expect((error as GrootError).hint).toContain("groot init");
    }
  });

  test("loadManifest + saveManifest round-trip", async () => {
    const base = await scratch();
    await writeFile(join(base, "groot.json"), JSON.stringify(VALID));
    const loaded = await loadManifest(join(base));
    expect(loaded.workspaceRoot).toBe(base);
    expect(loaded.manifest.scaffolds).toHaveLength(1);

    const updated = {
      ...loaded.manifest,
      scaffolds: [
        ...loaded.manifest.scaffolds,
        {
          slot: "api" as const,
          framework: "elysia" as const,
          path: "apps/api",
          generator: null,
          port: 3001,
        },
      ],
    };
    await saveManifest(loaded, updated);
    const reloaded = await loadManifest(base);
    expect(reloaded.manifest.scaffolds).toHaveLength(2);
  });
});
