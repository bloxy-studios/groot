/**
 * Renders the published JSON Schemas from the zod contracts:
 *
 *   schemas/v2/<name>.schema.json   one per registered contract
 *   schemas/v2/index.json           discovery index (name, title, url)
 *   schemas/groot.schema.json       groot.json — v1 or v2, discriminated by `version`
 *
 * schemas/groot.v1.schema.json is the frozen, hand-written v1 schema and is
 * never regenerated. scripts/generate-schemas.ts writes these files;
 * contracts.test.ts fails when the checked-in copies drift from the code.
 */
import { BLUEPRINT_VERSION, GROOT_JSON_SCHEMA_URL, MANIFEST_V1_VERSION } from "./blueprint.ts";
import { SCHEMA_BASE_URL, schemaUrl } from "./common.ts";
import { CONTRACTS, contractJsonSchema } from "./index.ts";

export interface RenderedFile {
  /** Repository-relative path. */
  readonly path: string;
  readonly content: string;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The combined groot.json schema: v1 documents validate against the frozen v1 schema, v2 against the blueprint. */
export function grootJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: GROOT_JSON_SCHEMA_URL,
    title: "groot.json",
    description:
      "Groot's project file. version 2 (blueprint, written by Groot v2) is a superset of version 1 (manifest, written by Groot v1 and still read by add/doctor). See docs/v2-architecture.md and docs/stability.md.",
    type: "object",
    required: ["version"],
    properties: {
      version: { enum: [MANIFEST_V1_VERSION, BLUEPRINT_VERSION] },
    },
    if: { properties: { version: { const: MANIFEST_V1_VERSION } } },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then/else keyword
    then: { $ref: "groot.v1.schema.json" },
    else: { $ref: "v2/blueprint.schema.json" },
  };
}

export function renderSchemaFiles(): RenderedFile[] {
  const files: RenderedFile[] = CONTRACTS.map((entry) => ({
    path: `schemas/v2/${entry.name}.schema.json`,
    content: pretty(contractJsonSchema(entry)),
  }));
  files.push({
    path: "schemas/v2/index.json",
    content: pretty({
      description:
        "Groot v2 machine contracts. Every v2 command's --json output is a result envelope whose data matches one of these.",
      baseUrl: SCHEMA_BASE_URL,
      contracts: CONTRACTS.map((entry) => ({
        name: entry.name,
        title: entry.title,
        description: entry.description,
        url: schemaUrl(entry.name),
      })),
    }),
  });
  files.push({ path: "schemas/groot.schema.json", content: pretty(grootJsonSchema()) });
  return files;
}
