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
import { normalizeArgv } from "./cli-compat.ts";
import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
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
  const schema = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../schemas/groot.schema.json"), "utf8"),
  ) as {
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
  };

  test("published URL and version match the code", () => {
    expect(schema.$id).toBe(MANIFEST_SCHEMA_URL);
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
  });
});
