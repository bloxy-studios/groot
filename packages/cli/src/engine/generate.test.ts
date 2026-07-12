import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import {
  cleanupTrunkExamples,
  growScaffold,
  moveDirContents,
  scrubGeneratorGit,
  writeFileSpecs,
} from "./generate.ts";
import { buildPlan } from "./plan.ts";

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

describe("scrubGeneratorGit", () => {
  test("removes a .git the generator created during the grow", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(await scrubGeneratorGit(dir, false)).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("preserves a .git that existed before the grow (merge onto a user sub-repo)", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(await scrubGeneratorGit(dir, true)).toBe(false);
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
  });

  test("no-op when the generator created nothing", async () => {
    const dir = await scratch();
    expect(await scrubGeneratorGit(dir, false)).toBe(false);
  });
});

describe("growScaffold git hygiene", () => {
  test("a .git that pre-dates the grow survives it (dir-conflict merge)", async () => {
    const base = await scratch();
    const targetDir = join(base, "ws");
    const plan = buildPlan({
      name: "ws",
      targetDir,
      cliVersion: "0.0.0-test",
      selections: { web: "none", mobile: "none", desktop: "none", api: "elysia", backend: "none" },
      options: {
        install: false,
        git: false,
        dirConflict: "merge",
        keepFailed: false,
        verbose: false,
      },
    });
    const scaffold = plan.scaffolds[0];
    if (scaffold === undefined) {
      throw new Error("expected the plan to contain the elysia scaffold");
    }
    // The user already tracks this directory — merge must not eat their repo.
    await mkdir(join(targetDir, scaffold.path, ".git"), { recursive: true });
    await writeFile(join(targetDir, scaffold.path, ".git", "HEAD"), "ref: refs/heads/main\n");

    const steps: string[] = [];
    await growScaffold(plan, scaffold, { verbose: false, onStep: (label) => steps.push(label) });

    // The scaffold grew…
    expect(existsSync(join(targetDir, scaffold.path, "src", "index.ts"))).toBe(true);
    // …and the pre-existing .git was preserved, with no scrub step reported.
    expect(existsSync(join(targetDir, scaffold.path, ".git", "HEAD"))).toBe(true);
    expect(steps.some((label) => label.includes("Removed generator-created .git"))).toBe(false);
  });
});
