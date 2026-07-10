import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { MIN_BUN_VERSION, resolveDirConflict, versionAtLeast } from "./preflight.ts";

describe("versionAtLeast", () => {
  test("compares release segments numerically", () => {
    expect(versionAtLeast("1.2.0", "1.2.0")).toBe(true);
    expect(versionAtLeast("1.3.14", "1.2.0")).toBe(true);
    expect(versionAtLeast("2.0.0", "1.9.9")).toBe(true);
    expect(versionAtLeast("1.1.9", "1.2.0")).toBe(false);
    expect(versionAtLeast("0.9.0", "1.0.0")).toBe(false);
    expect(versionAtLeast("1.10.0", "1.9.0")).toBe(true); // not lexicographic
  });

  test("ignores prerelease suffixes", () => {
    expect(versionAtLeast("1.2.0-canary.1", "1.2.0")).toBe(true);
  });

  test("minimum bun version stays in sync with package.json engines", async () => {
    const pkg = await import("../../package.json");
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  });
});

describe("resolveDirConflict", () => {
  async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), "groot-preflight-"));
  }

  test("nonexistent target passes through unchanged", async () => {
    const base = await scratch();
    const target = join(base, "fresh");
    expect(await resolveDirConflict(target, "error")).toBe(target);
  });

  test("empty directory passes through unchanged", async () => {
    const base = await scratch();
    const target = join(base, "empty");
    await mkdir(target);
    expect(await resolveDirConflict(target, "error")).toBe(target);
  });

  test("error policy throws EXIT.PREFLIGHT on a non-empty target", async () => {
    const base = await scratch();
    const target = join(base, "busy");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "hi");
    try {
      await resolveDirConflict(target, "error");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GrootError);
      expect((error as GrootError).exitCode).toBe(EXIT.PREFLIGHT);
      expect((error as GrootError).hint).toContain("--dir-conflict");
    }
  });

  test("merge policy keeps the non-empty target", async () => {
    const base = await scratch();
    const target = join(base, "busy");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "hi");
    expect(await resolveDirConflict(target, "merge")).toBe(target);
  });

  test("increment policy picks the first free numbered sibling", async () => {
    const base = await scratch();
    const target = join(base, "app");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "hi");
    expect(await resolveDirConflict(target, "increment")).toBe(join(base, "app-1"));

    // app-1 occupied too → app-2. (Empty candidate dirs are reused.)
    await mkdir(join(base, "app-1"));
    await writeFile(join(base, "app-1", "keep.txt"), "hi");
    expect(await resolveDirConflict(target, "increment")).toBe(join(base, "app-2"));
  });

  test("a file in the way counts as a conflict", async () => {
    const base = await scratch();
    const target = join(base, "collide");
    await writeFile(target, "i am a file");
    expect(await resolveDirConflict(target, "increment")).toBe(join(base, "collide-1"));
  });
});
