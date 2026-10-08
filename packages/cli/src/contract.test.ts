/**
 * The stability-contract tripwire (docs/stability.md#enforcement): snapshots
 * the covered CLI surface — command flags, aliases, exit codes, bun-create
 * routing, and the manifest schema's invariants. If a change here surprises
 * you, read docs/stability.md before updating the snapshot: covered-surface
 * changes are semver-relevant and must land with the right release plan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_COMMANDS, normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
import { V2_COMMANDS } from "./commands/schema.ts";
import { BLUEPRINT_VERSION, FRAMEWORK_IDS, SLOT_IDS } from "./core/contracts/blueprint.ts";
import { schemaUrl } from "./core/contracts/common.ts";
import { allFrameworkIds } from "./engine/add.ts";
import { EXIT } from "./engine/errors.ts";
import { SLOT_ORDER } from "./engine/matrix.ts";
import { MANIFEST_SCHEMA_URL, MANIFEST_VERSION } from "./engine/types.ts";

/**
 * Citty types `args` as Resolvable (object | promise | factory); groot's
 * commands always use literal objects — assert that, then read the keys.
 */
const argsOf = (command: { args?: unknown }): Record<string, { alias?: string }> => {
  const args = command.args;
  if (typeof args !== "object" || args === null) {
    throw new Error("expected a literal args object on the command definition");
  }
  return args as Record<string, { alias?: string }>;
};
const flagsOf = (command: { args?: unknown }): string[] => Object.keys(argsOf(command)).sort();

describe("stability contract: command surface", () => {
  test("groot init flags", () => {
    expect(flagsOf(init)).toEqual(
      [
        "dir",
        "name",
        "web",
        "mobile",
        "desktop",
        "api",
        "backend",
        "preset",
        "yes",
        "dry-run",
        "json",
        "install",
        "git",
        "github",
        "public",
        "dir-conflict",
        "topology",
        "keep-failed",
        "verbose",
      ].sort(),
    );
    // -y is a documented alias (cli-spec flag table).
    expect(argsOf(init).yes?.alias).toBe("y");
  });

  test("groot add flags", () => {
    expect(flagsOf(add)).toEqual(
      ["framework", "path", "install", "keep-failed", "dry-run", "json", "verbose"].sort(),
    );
  });

  test("groot doctor flags", () => {
    expect(flagsOf(doctor)).toEqual(["dir", "json"].sort());
  });

  test("bun-create routing: known subcommands pass through, bare destinations go to init", () => {
    expect(normalizeArgv(["init", "my-app"])).toEqual(["init", "my-app"]);
    expect(normalizeArgv(["add", "hono"])).toEqual(["add", "hono"]);
    expect(normalizeArgv(["doctor"])).toEqual(["doctor"]);
    expect(normalizeArgv(["my-app", "--yes"])).toEqual(["init", "my-app", "--yes"]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
  });

  test("bun-create routing: the reserved command names are frozen (v2-cli-spec.md#bare-word-routing)", () => {
    expect([...KNOWN_COMMANDS].sort()).toEqual(
      [
        // v1
        "init",
        "add",
        "doctor",
        // v2
        "inspect",
        "adopt",
        "migrate",
        "plan",
        "apply",
        "status",
        "resume",
        "rollback",
        "verify",
        "evidence",
        "context",
        "mcp",
        "schema",
        "task",
        "review",
      ].sort(),
    );
    // Every v1 command and every v2 command `groot schema` lists is a command, never a destination.
    for (const name of ["init", "add", "doctor", ...V2_COMMANDS.map((command) => command.name)]) {
      expect(KNOWN_COMMANDS.has(name)).toBe(true);
      expect(normalizeArgv([name, "x"])).toEqual([name, "x"]);
    }
  });
});

describe("stability contract: exit codes", () => {
  test("the exit-code table is frozen (cli-spec.md#exit-codes)", () => {
    expect(EXIT).toEqual({
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      PREFLIGHT: 3,
      GENERATOR: 4,
      STITCH: 5,
      CANCELLED: 130,
    });
  });
});

describe("stability contract: groot.json schema", () => {
  const readSchema = <T>(file: string): T =>
    JSON.parse(readFileSync(join(import.meta.dir, "../../../schemas", file), "utf8")) as T;

  // The frozen v1 schema (docs/stability.md#manifest-schema-evolution): v1
  // workspaces stay valid and add/doctor keep reading them.
  const schema = readSchema<{
    $id: string;
    required: string[];
    properties: {
      version: { const: number };
      scaffolds: {
        items: {
          required: string[];
          properties: { slot: { enum: string[] }; framework: { enum: string[] } };
        };
      };
    };
  }>("groot.v1.schema.json");

  // The published URL keeps its meaning — "the newest version" — and accepts
  // both versions, discriminated by `version` (deliberate v2 change).
  const combined = readSchema<{
    $id: string;
    properties: { version: { enum: number[] } };
    then: { $ref: string };
    else: { $ref: string };
  }>("groot.schema.json");

  test("published URL and versions match the code", () => {
    expect(combined.$id).toBe(MANIFEST_SCHEMA_URL);
    expect(combined.properties.version.enum).toEqual([MANIFEST_VERSION, BLUEPRINT_VERSION]);
    expect(combined.then.$ref).toBe("groot.v1.schema.json");
    expect(combined.else.$ref).toBe("v2/blueprint.schema.json");
    expect(schema.properties.version.const).toBe(MANIFEST_VERSION);
  });

  test("required shapes are frozen", () => {
    expect([...schema.required].sort()).toEqual(
      ["version", "createdWith", "conventions", "scaffolds"].sort(),
    );
    expect([...schema.properties.scaffolds.items.required].sort()).toEqual(
      ["slot", "framework", "path", "generator", "port"].sort(),
    );
  });

  test("slot and framework enums stay in lockstep with the live matrix", () => {
    expect([...schema.properties.scaffolds.items.properties.slot.enum].sort()).toEqual(
      [...SLOT_ORDER].sort(),
    );
    expect([...schema.properties.scaffolds.items.properties.framework.enum].sort()).toEqual(
      [...allFrameworkIds()].sort(),
    );
    // The v2 blueprint's `scaffolds` keeps exactly the v1 vocabulary.
    expect([...SLOT_IDS].sort()).toEqual([...SLOT_ORDER].sort());
    expect([...FRAMEWORK_IDS].map(String).sort()).toEqual([...allFrameworkIds()].sort());
  });

  // groot.json version 2 (the blueprint) is covered too. The drift test only
  // proves schemas/ matches the zod source, so a breaking zod change that is
  // regenerated would pass it — this snapshot is what trips.
  const blueprint = readSchema<{
    $id: string;
    required: string[];
    properties: {
      version: { const: number };
      project: {
        required: string[];
        properties: { topology: { enum: string[] }; origin: { enum: string[] } };
      };
      apps: {
        items: {
          required: string[];
          properties: { kind: { enum: string[] }; origin: { enum: string[] } };
        };
      };
      policy: { required: string[] };
    };
  }>("v2/blueprint.schema.json");

  test("v2 blueprint: URL, version, and required shapes are frozen", () => {
    expect(blueprint.$id).toBe(schemaUrl("blueprint"));
    expect(blueprint.properties.version.const).toBe(BLUEPRINT_VERSION);
    expect([...blueprint.required].sort()).toEqual(
      [
        "$schema",
        "version",
        "createdWith",
        "conventions",
        "scaffolds",
        "project",
        "apps",
        "capabilities",
        "decisions",
        "environment",
        "verification",
        "context",
        "policy",
      ].sort(),
    );
    expect([...blueprint.properties.project.required].sort()).toEqual(
      ["name", "topology", "packageManager", "origin"].sort(),
    );
    expect([...blueprint.properties.apps.items.required].sort()).toEqual(
      ["id", "path", "kind", "framework", "packageName", "port", "origin", "entry"].sort(),
    );
    expect([...blueprint.properties.policy.required].sort()).toEqual(["allow", "external"].sort());
  });

  test("v2 blueprint: topology, origin, and app kind enums are frozen", () => {
    const { project, apps } = blueprint.properties;
    expect([...project.properties.topology.enum].sort()).toEqual(["monorepo", "single"]);
    expect([...project.properties.origin.enum].sort()).toEqual(["adopted", "created", "migrated"]);
    expect([...apps.items.properties.kind.enum].sort()).toEqual(
      ["web", "mobile", "desktop", "api", "backend", "library", "config", "unknown"].sort(),
    );
    expect([...apps.items.properties.origin.enum].sort()).toEqual(["adopted", "generated"]);
  });
});
