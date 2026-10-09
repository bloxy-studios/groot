/**
 * groot.json / groot.lock.json: reading with exact error ids and issue
 * paths, canonical serialization, the deterministic v1 → v2 migration, the
 * adoption blueprint, and lock helpers.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { BlueprintV2, type ManifestV1 } from "../contracts/blueprint.ts";
import { GrootLock } from "../contracts/lock.ts";
import { json, makeProject, V1_MANIFEST } from "../discovery/test-projects.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import {
  blueprintFixture,
  fixtureFact,
  observationFixture,
  unitFixture,
} from "../test-fixtures.ts";
import {
  blueprintFromObservation,
  emptyLock,
  migrateV1ToV2,
  migrationLock,
  parseGeneratorSpec,
  readLock,
  readManifest,
  serializeBlueprint,
  serializeLock,
} from "./index.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");

/** chmod 000 makes a file unreadable only on POSIX and only for a non-root user. */
const CAN_REVOKE_READ = process.platform !== "win32" && process.getuid?.() !== 0;

async function errorOf(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
  throw new Error("expected a GrootV2Error");
}

function v1(): ManifestV1 {
  return structuredClone(V1_MANIFEST) as unknown as ManifestV1;
}

describe("readManifest", () => {
  test("absent, v1, and v2 documents (sha256 over the exact bytes)", async () => {
    // Arrange
    const raw = json(V1_MANIFEST);
    const absentRoot = makeProject({});
    const v1Root = makeProject({ "groot.json": raw });
    const v2Root = makeProject({ "groot.json": serializeBlueprint(blueprintFixture()) });

    // Act
    const [absent, first, second] = await Promise.all([
      readManifest(absentRoot),
      readManifest(v1Root),
      readManifest(v2Root),
    ]);

    // Assert
    expect(absent).toEqual({ state: "absent" });
    expect(first).toMatchObject({ state: "v1", raw, sha256: sha256Of(raw) });
    expect(second.state).toBe("v2");
  });

  test("version 3 → GROOT_E_UNSUPPORTED_SCHEMA (d)", async () => {
    // Arrange
    const root = makeProject({
      "groot.json": json({ version: 3, createdWith: "create-groot@9.0.0" }),
    });

    // Act
    const error = await errorOf(readManifest(root));

    // Assert
    expect(error.id).toBe("GROOT_E_UNSUPPORTED_SCHEMA");
    expect(error.message).toContain("this CLI reads versions 1 and 2");
    expect(error.details).toMatchObject({ version: 3, supported: [1, 2] });
  });

  test.each([
    ["malformed JSON", "{ nope", ""],
    ["a JSON array", "[]", ""],
    ["a missing version", json({ createdWith: "create-groot@1.0.0" }), "/version"],
    [
      "a framework outside its slot (validateManifest parity)",
      json({ ...V1_MANIFEST, scaffolds: [{ ...V1_MANIFEST.scaffolds[0], framework: "hono" }] }),
      "/scaffolds/0/framework",
    ],
    [
      "an unknown key in a v1 scaffold",
      json({ ...V1_MANIFEST, scaffolds: [{ ...V1_MANIFEST.scaffolds[0], extra: true }] }),
      "/scaffolds/0",
    ],
    [
      "duplicate v2 app ids",
      serializeBlueprint(
        blueprintFixture({
          apps: [
            {
              ...blueprintFixture().apps[0],
              id: "api",
              path: "apps/a",
            } as BlueprintV2["apps"][number],
            {
              ...blueprintFixture().apps[0],
              id: "api",
              path: "apps/b",
            } as BlueprintV2["apps"][number],
          ],
        }),
      ),
      "/apps/1/id",
    ],
  ])("%s → GROOT_E_INVALID_DOCUMENT with the issue path (d)", async (_label, content, path) => {
    // Arrange
    const root = makeProject({ "groot.json": content });

    // Act
    const error = await errorOf(readManifest(root));

    // Assert
    expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    const issues = (error.details?.issues ?? []) as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain(path);
  });

  test.skipIf(!CAN_REVOKE_READ)(
    "a groot.json that cannot be read → GROOT_E_INVALID_DOCUMENT naming the cause, never a raw fs error",
    async () => {
      // Arrange
      const root = makeProject({ "groot.json": json(V1_MANIFEST) });
      chmodSync(join(root, "groot.json"), 0o000);

      // Act
      const error = await errorOf(readManifest(root));

      // Assert
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(error.message).toContain("could not be read (EACCES)");
      expect(error.hint).toContain("readable");
      expect(error.details).toMatchObject({ path: "groot.json", issues: [{ path: "" }] });
    },
  );

  test.skipIf(process.platform === "win32")(
    "a groot.json symlink that leads nowhere is invalid (the executor would never replace it), not absent",
    async () => {
      // Arrange: a dangling link, and a link through a regular file (ENOTDIR).
      const dangling = makeProject({});
      symlinkSync("missing.json", join(dangling, "groot.json"));
      const throughFile = makeProject({ "package.json": json({ name: "x" }) });
      symlinkSync("package.json/x", join(throughFile, "groot.json"));

      // Act
      const errors = {
        dangling: await errorOf(readManifest(dangling)),
        throughFile: await errorOf(readManifest(throughFile)),
      };

      // Assert
      for (const [code, error] of [
        ["ENOENT", errors.dangling],
        ["ENOTDIR", errors.throughFile],
      ] as const) {
        expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
        expect(error.message).toContain(`is a symlink whose target does not exist (${code})`);
        expect(error.hint).toContain("symlinks");
      }
    },
  );

  test("nothing at all is absent: a missing root, a root that is a file, no groot.json", async () => {
    // Arrange
    const project = makeProject({ "file.txt": "x" });

    // Act
    const reads = await Promise.all([
      readManifest(join(project, "no-such-dir")),
      readManifest(join(project, "file.txt")),
      readManifest(project),
    ]);

    // Assert
    expect(reads).toEqual([{ state: "absent" }, { state: "absent" }, { state: "absent" }]);
  });

  test.skipIf(process.platform === "win32")(
    "a groot.json symlink that loops or leaves the project gets the reader's next step, not the write-side hint",
    async () => {
      // Arrange
      const looping = makeProject({});
      symlinkSync("groot.json", join(looping, "groot.json"));
      const outside = makeProject({});
      symlinkSync(
        join(makeProject({ "x.json": json(V1_MANIFEST) }), "x.json"),
        join(outside, "groot.json"),
      );

      // Act
      const errors = [await errorOf(readManifest(looping)), await errorOf(readManifest(outside))];

      // Assert
      for (const error of errors) {
        expect(error.id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
        expect(error.hint).toContain("Make groot.json a readable regular file inside the project");
        expect(error.hint).not.toContain("only writes");
      }
    },
  );
});

describe("serializeBlueprint", () => {
  test("contract key order at every level, unknown keys kept last, trailing newline", () => {
    // Arrange
    const doc = blueprintFixture();
    const shuffled = {
      zeta: { kept: true },
      ...Object.fromEntries(Object.entries(doc).reverse()),
      // Same position as in the reversed spread, but each app's keys reversed too.
      apps: doc.apps.map((app) => Object.fromEntries(Object.entries(app).reverse())),
    } as unknown as BlueprintV2;

    // Act
    const text = serializeBlueprint(shuffled);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    // Assert
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toBe(
      serializeBlueprint(doc).replace(/\n}\n$/, ',\n  "zeta": {\n    "kept": true\n  }\n}\n'),
    );
    expect(Object.keys(parsed)).toEqual([
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
      "zeta",
    ]);
    expect(Object.keys((parsed.apps as object[])[0] as object)).toEqual([
      "id",
      "path",
      "kind",
      "framework",
      "packageName",
      "port",
      "origin",
      "entry",
    ]);
  });
});

describe("migrateV1ToV2", () => {
  const observation = observationFixture([
    unitFixture({ path: "apps/api", packageName: "api", entry: fixtureFact("src/server.ts") }),
    unitFixture({ path: "apps/web", packageName: "web", entry: fixtureFact(null) }),
  ]);

  test("deterministic: byte-identical for the same inputs; the clock only stamps the decision", () => {
    // Arrange / Act
    const first = serializeBlueprint(migrateV1ToV2(v1(), observation, NOW));
    const second = serializeBlueprint(migrateV1ToV2(v1(), observation, NOW));
    const later = serializeBlueprint(
      migrateV1ToV2(v1(), observation, new Date("2027-01-01T00:00:00Z")),
    );

    // Assert
    expect(first).toBe(second);
    const strip = (text: string) =>
      text.replace(/"at": "[^"]+"/, '"at": ""').replace(/"id": "dec_[0-9a-z]+"/, '"id": ""');
    expect(strip(later)).toBe(strip(first));
    expect(later).not.toBe(first);
  });

  test("v1 fields verbatim, scaffolds become generated apps enriched by discovery", () => {
    // Arrange / Act
    const doc = migrateV1ToV2(v1(), observation, NOW);

    // Assert
    expect(BlueprintV2.safeParse(doc).success).toBe(true);
    expect(doc.createdWith).toBe("create-groot@1.10.0");
    expect(doc.conventions).toEqual({ packagesNamespace: "@repo" });
    expect(doc.scaffolds).toEqual(v1().scaffolds);
    expect(doc.project).toEqual({
      name: "fixture",
      topology: "monorepo",
      packageManager: "bun",
      origin: "migrated",
    });
    expect(doc.apps).toEqual([
      {
        id: "web",
        path: "apps/web",
        kind: "web",
        framework: "next",
        packageName: "web",
        port: 3000,
        origin: "generated",
        entry: null,
      },
      {
        id: "api",
        path: "apps/api",
        kind: "api",
        framework: "hono",
        packageName: "api",
        port: 3001,
        origin: "generated",
        entry: "src/server.ts",
      },
      {
        id: "backend",
        path: "packages/backend",
        kind: "backend",
        framework: "convex",
        packageName: null,
        port: null,
        origin: "generated",
        entry: null,
      },
    ]);
    expect(doc.capabilities).toEqual([]);
    expect(doc.environment).toEqual([]);
    expect(doc.decisions).toHaveLength(1);
    expect(doc.decisions[0]).toMatchObject({
      topic: "migration.v1-to-v2",
      authority: "recipe",
      at: NOW.toISOString(),
    });
    expect(doc.verification.map((contract) => contract.id)).toEqual([
      "structural.package.web",
      "structural.package.api",
      "structural.package.backend",
    ]);
  });

  test("ids from path basenames are de-duplicated with -2 suffixes", () => {
    // Arrange
    const manifest = v1();
    const twoWebs = {
      ...manifest,
      scaffolds: [manifest.scaffolds[0], { ...manifest.scaffolds[0], path: "sites/web/" }],
    } as ManifestV1;

    // Act
    const doc = migrateV1ToV2(twoWebs, observationFixture([]), NOW);

    // Assert
    expect(doc.apps.map((app) => [app.id, app.path])).toEqual([
      ["web", "apps/web"],
      ["web-2", "sites/web"],
    ]);
    expect(doc.scaffolds[1]?.path).toBe("sites/web/");
  });

  test("a scaffold path escaping the project is refused", () => {
    // Arrange
    const manifest = v1();
    const escaping = {
      ...manifest,
      scaffolds: [{ ...manifest.scaffolds[0], path: "../elsewhere" }],
    } as ManifestV1;

    // Act / Assert
    expect(() => migrateV1ToV2(escaping, observationFixture([]), NOW)).toThrow(GrootV2Error);
  });
});

describe("blueprintFromObservation", () => {
  test("units become adopted apps (config excluded), best port, namespace from scopes", () => {
    // Arrange
    const observation = observationFixture([
      unitFixture({
        path: "services/edge",
        packageName: "@acme/edge",
        ports: [
          { ...fixtureFact(4400), confidence: "medium" },
          { ...fixtureFact(4310), confidence: "high" },
        ],
      }),
      unitFixture({
        path: "packages/ui",
        packageName: "@acme/ui",
        kind: fixtureFact("library" as const),
      }),
      unitFixture({
        path: "packages/tsconfig",
        packageName: "@acme/tsconfig",
        kind: fixtureFact("config" as const),
      }),
    ]);

    // Act
    const doc = blueprintFromObservation(observation, { now: NOW });

    // Assert
    expect(BlueprintV2.safeParse(doc).success).toBe(true);
    expect(doc.apps.map((app) => [app.id, app.path, app.kind, app.port, app.origin])).toEqual([
      ["edge", "services/edge", "api", 4310, "adopted"],
      ["ui", "packages/ui", "library", null, "adopted"],
    ]);
    expect(doc.conventions.packagesNamespace).toBe("@acme");
    expect(doc.scaffolds).toEqual([]);
    expect(doc.project.origin).toBe("adopted");
    expect(doc.decisions[0]).toMatchObject({
      topic: "adoption.layout",
      authority: "default",
      at: NOW.toISOString(),
    });
    expect(serializeBlueprint(blueprintFromObservation(observation, { now: NOW }))).toBe(
      serializeBlueprint(doc),
    );
  });

  test("a root single app is named after its package (scope dropped) or 'app'", () => {
    // Arrange
    const single = (packageName: string | null) => {
      const observation = observationFixture([unitFixture({ path: ".", packageName })]);
      return { ...observation, topology: fixtureFact("single" as const) };
    };

    // Act / Assert
    expect(blueprintFromObservation(single("@acme/Edge API"), { now: NOW }).apps[0]?.id).toBe(
      "edge-api",
    );
    expect(blueprintFromObservation(single(null), { now: NOW }).apps[0]?.id).toBe("app");
    expect(blueprintFromObservation(single(null), { now: NOW }).conventions.packagesNamespace).toBe(
      "@repo",
    );
  });
});

describe("lock helpers", () => {
  test("generator specs split on the version '@', scopes kept", () => {
    // Arrange / Act / Assert
    expect(parseGeneratorSpec("create-next-app@16")).toEqual({
      package: "create-next-app",
      range: "16",
    });
    expect(parseGeneratorSpec("@tanstack/cli@0.69")).toEqual({
      package: "@tanstack/cli",
      range: "0.69",
    });
    expect(parseGeneratorSpec("@scope/tool")).toEqual({ package: "@scope/tool", range: "*" });
  });

  test("migration lock: unresolved generator entries per scaffold, valid and stable", () => {
    // Arrange
    const manifest = v1();

    // Act
    const lock = migrationLock(manifest.scaffolds, NOW);

    // Assert
    expect(GrootLock.safeParse(lock).success).toBe(true);
    expect(lock.generators).toEqual([
      {
        package: "create-next-app",
        range: "16",
        version: null,
        integrity: null,
        tarball: null,
        resolvedAt: NOW.toISOString(),
        source: "unresolved",
        usedBy: ["apps/web"],
      },
      {
        package: "create-hono",
        range: "0.19",
        version: null,
        integrity: null,
        tarball: null,
        resolvedAt: NOW.toISOString(),
        source: "unresolved",
        usedBy: ["apps/api"],
      },
    ]);
    expect(serializeLock(lock)).toBe(serializeLock(migrationLock(manifest.scaffolds, NOW)));
  });

  test("readLock: absent, present, unsupported lockVersion, invalid", async () => {
    // Arrange
    const lockText = serializeLock(emptyLock());
    const roots = {
      absent: makeProject({}),
      present: makeProject({ "groot.lock.json": lockText }),
      newer: makeProject({ "groot.lock.json": json({ lockVersion: 2 }) }),
      invalid: makeProject({ "groot.lock.json": json({ lockVersion: 1, generators: "nope" }) }),
    };

    // Act
    const absent = await readLock(roots.absent);
    const present = await readLock(roots.present);
    const newer = await errorOf(readLock(roots.newer));
    const invalid = await errorOf(readLock(roots.invalid));

    // Assert
    expect(absent).toEqual({ state: "absent" });
    expect(present).toMatchObject({ state: "present", raw: lockText, sha256: sha256Of(lockText) });
    expect(newer.id).toBe("GROOT_E_UNSUPPORTED_SCHEMA");
    expect(invalid.id).toBe("GROOT_E_INVALID_DOCUMENT");
  });

  test.skipIf(process.platform === "win32")(
    "readLock: a groot.lock.json symlink that leads nowhere is invalid, not absent",
    async () => {
      // Arrange
      const root = makeProject({});
      symlinkSync("elsewhere/groot.lock.json", join(root, "groot.lock.json"));

      // Act
      const error = await errorOf(readLock(root));

      // Assert
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(error.message).toContain("groot.lock.json is invalid");
      expect(error.hint).toContain("Make groot.lock.json a readable regular file");
    },
  );
});
