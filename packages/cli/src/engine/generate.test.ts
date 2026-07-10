import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { cleanupTrunkExamples, moveDirContents, writeFileSpecs } from "./generate.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "groot-generate-"));
}

describe("moveDirContents", () => {
  test("moves every entry into a created destination", async () => {
    const base = await scratch();
    const src = join(base, "src");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "a.txt"), "a");
    await writeFile(join(src, "nested", "b.txt"), "b");

    const dest = join(base, "dest");
    await moveDirContents(src, dest);

    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(dest, "nested", "b.txt"), "utf8")).toBe("b");
  });

  test("refuses to overwrite — collisions throw EXIT.GENERATOR and leave dest untouched", async () => {
    const base = await scratch();
    const src = join(base, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "package.json"), "{}");

    const dest = join(base, "dest");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "package.json"), '{"mine": true}');

    try {
      await moveDirContents(src, dest);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      expect((error as GrootError).exitCode).toBe(EXIT.GENERATOR);
      expect((error as GrootError).message).toContain("package.json");
    }
    // Pre-existing user files always win.
    expect(await readFile(join(dest, "package.json"), "utf8")).toBe('{"mine": true}');
  });
});

describe("cleanupTrunkExamples", () => {
  test("removes example apps/packages but keeps typescript-config", async () => {
    const root = await scratch();
    for (const path of [
      "apps/web/src",
      "apps/docs/src",
      "packages/ui/src",
      "packages/eslint-config",
      "packages/typescript-config",
    ]) {
      await mkdir(join(root, path), { recursive: true });
    }

    const removed = await cleanupTrunkExamples(root);

    expect(removed.sort()).toEqual([
      "apps/docs",
      "apps/web",
      "packages/eslint-config",
      "packages/ui",
    ]);
    expect(existsSync(join(root, "apps/web"))).toBe(false);
    expect(existsSync(join(root, "packages/typescript-config"))).toBe(true);
  });

  test("is a no-op on an empty tree", async () => {
    const root = await scratch();
    expect(await cleanupTrunkExamples(root)).toEqual([]);
  });
});

describe("writeFileSpecs", () => {
  test("creates intermediate directories and writes contents", async () => {
    const root = await scratch();
    await writeFileSpecs(root, [
      { path: "apps/api/src/index.ts", contents: "export {};\n" },
      { path: "apps/api/package.json", contents: "{}\n" },
    ]);
    expect(await readFile(join(root, "apps/api/src/index.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(join(root, "apps/api/package.json"))).toBe(true);
  });
});
