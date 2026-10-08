/**
 * Single-app generation failures (no real generator: a fake create-hono writes
 * partial output, then exits 1). Without --keep-failed a target groot created
 * is removed; with it, the partial output is kept — in the target when groot
 * would have created it, otherwise in the stage, which the error names.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { GrootError } from "./errors.ts";
import { buildPlan } from "./plan.ts";
import { generateSingle, singleRootPlan, validateSingleSelection } from "./single.ts";

interface FailedRun {
  readonly base: string;
  readonly target: string;
  readonly error: unknown;
}

async function runFailingHono(
  keepFailed: boolean,
  prepareTarget?: (target: string) => Promise<void>,
): Promise<FailedRun> {
  const base = await mkdtemp(join(tmpdir(), "groot-single-test-"));
  const target = join(base, "svc");
  await prepareTarget?.(target);
  const draft = buildPlan({
    name: "svc",
    targetDir: target,
    cliVersion: "2.0.0",
    selections: { web: "none", mobile: "none", desktop: "none", api: "hono", backend: "none" },
    options: { install: false, git: false, dirConflict: "merge", keepFailed, verbose: false },
  });
  const plan = singleRootPlan(draft, validateSingleSelection(draft.scaffolds, target));
  const generator = spyOn(ADAPTERS.hono, "command").mockImplementation((ctx) => ({
    argv: [
      "sh",
      "-c",
      'mkdir -p "$0/src" && echo partial > "$0/src/index.ts" && exit 1',
      ctx.scaffold.path,
    ],
    cwd: ctx.plan.targetDir,
    label: "fake hono",
  }));
  try {
    await generateSingle(plan, { verbose: false });
    return { base, target, error: undefined };
  } catch (error) {
    return { base, target, error };
  } finally {
    generator.mockRestore();
  }
}

describe("generateSingle failures", () => {
  test("without --keep-failed the partially-created target is removed", async () => {
    const { base, error } = await runFailingHono(false);
    expect(error).toBeInstanceOf(GrootError);
    expect((error as GrootError).message).toContain("The partially-created directory was removed.");
    expect(readdirSync(base)).toEqual([]);
  });

  test("--keep-failed keeps the partial output in the target groot would have created", async () => {
    const { base, target, error } = await runFailingHono(true);
    expect(error).toBeInstanceOf(GrootError);
    expect((error as GrootError).message).toContain(`Partial output was kept in ${target}`);
    expect(readFileSync(join(target, "src/index.ts"), "utf8")).toBe("partial\n");
    expect(readdirSync(base)).toEqual(["svc"]);
  });

  test("--keep-failed never merges partial output into an existing target: the stage is kept and named", async () => {
    const { base, target, error } = await runFailingHono(true, async (dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "notes.md"), "mine\n");
    });
    expect(readdirSync(target)).toEqual(["notes.md"]);
    const stage = readdirSync(base).find((name) => name.startsWith("groot-single-"));
    expect(stage).toBeDefined();
    const kept = join(base, stage as string, "svc");
    expect(readFileSync(join(kept, "src/index.ts"), "utf8")).toBe("partial\n");
    expect((error as GrootError).message).toContain(`Partial output was kept in ${kept}`);
  });
});
