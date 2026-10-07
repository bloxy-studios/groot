/**
 * Contract tripwires: the published JSON Schemas must match the zod source
 * (run `bun scripts/generate-schemas.ts` after changing a contract), and the
 * contracts must accept the documents Groot itself produces.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManifestV1 } from "./blueprint.ts";
import { renderSchemaFiles } from "./render.ts";

const repoRoot = join(import.meta.dir, "../../../../..");

describe("published schemas", () => {
  test("schemas/ matches the zod contracts (regenerate with bun scripts/generate-schemas.ts)", () => {
    const stale = renderSchemaFiles().filter((file) => {
      try {
        return readFileSync(join(repoRoot, file.path), "utf8") !== file.content;
      } catch {
        return true;
      }
    });
    expect(stale.map((file) => file.path)).toEqual([]);
  });

  test("the zod v1 manifest accepts exactly what the frozen v1 schema documents", () => {
    const valid = {
      $schema:
        "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json",
      version: 1,
      createdWith: "create-groot@1.10.0",
      conventions: { packagesNamespace: "@repo" },
      scaffolds: [
        {
          slot: "web",
          framework: "next",
          path: "apps/web",
          generator: "create-next-app@16",
          port: 3000,
        },
        {
          slot: "backend",
          framework: "convex",
          path: "packages/backend",
          generator: null,
          port: null,
        },
      ],
    };
    expect(ManifestV1.safeParse(valid).success).toBe(true);
    expect(ManifestV1.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(
      ManifestV1.safeParse({
        ...valid,
        scaffolds: [
          { slot: "web", framework: "remix", path: "apps/web", generator: null, port: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});
