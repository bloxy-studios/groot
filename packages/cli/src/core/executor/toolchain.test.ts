/**
 * Toolchain preconditions run nothing a plan names: only allowlisted tool
 * names are probed (with `--version`, found on PATH, never from inside the
 * project); a path, an unknown name, or a project-local binary is reported
 * as a finding without being executed — even by the read-only freshness check.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan, Precondition } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { applyPlan, checkPlanFreshness } from "./index.ts";
import {
  buildPlan,
  refingerprint,
  removeScratchDirs,
  scratchDir,
  scratchProject,
  testContext,
} from "./test-support.ts";

afterAll(removeScratchDirs);

/** An executable script that leaves `marker` behind if anything runs it. */
function payload(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "ran with $1" > '${marker}'\necho 99.0.0\n`);
  chmodSync(path, 0o755);
  return path;
}

async function planWith(
  root: string,
  toolchain: Omit<Precondition & { type: "toolchain" }, "type">,
) {
  const plan = await buildPlan(root, async (b) => {
    await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
  });
  const pre: Precondition = { type: "toolchain", ...toolchain };
  return refingerprint({ ...plan, preconditions: [...plan.preconditions, pre] });
}

async function applyError(root: string, plan: OperationPlan): Promise<GrootV2Error> {
  try {
    await applyPlan(testContext(root).ctx, {
      plan,
      root,
      policy: { allow: ["fs.create"], external: "deny" },
      command: "apply",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

/** Run `body` with `dir` first on PATH. */
async function withPathFirst<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = saved;
  }
}

describe.skipIf(process.platform === "win32")("toolchain preconditions", () => {
  test("a plan-named absolute path is a finding and is never executed", async () => {
    // Arrange
    const outside = scratchDir("groot-toolchain-");
    const marker = join(outside, "ran");
    const script = payload(outside, "payload.sh", marker);
    const root = scratchProject();
    const plan = await planWith(root, {
      id: script,
      minVersion: null,
      reason: "needs the payload",
    });

    // Act
    const findings = await checkPlanFreshness(root, plan);
    const error = await applyError(root, plan);

    // Assert
    expect(findings.map((finding) => finding.path)).toEqual([`toolchain:${script}`]);
    expect(error.id).toBe("GROOT_E_STALE_PLAN");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  test("a bare name outside the allowlist is a finding and is never executed", async () => {
    // Arrange
    const bin = scratchDir("groot-toolchain-bin-");
    const marker = join(bin, "ran");
    payload(bin, "evil-tool", marker);
    const root = scratchProject();
    const plan = await planWith(root, { id: "evil-tool", minVersion: null, reason: "x" });

    // Act
    const findings = await withPathFirst(bin, () => checkPlanFreshness(root, plan));

    // Assert
    expect(findings.map((finding) => finding.path)).toEqual(["toolchain:evil-tool"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("an allowlisted name that resolves inside the project is a finding and is never executed", async () => {
    // Arrange
    const root = scratchProject();
    const marker = join(root, "ran");
    payload(join(root, "bin"), "node", marker);
    const plan = await planWith(root, { id: "node", minVersion: null, reason: "x" });

    // Act
    const findings = await withPathFirst(join(root, "bin"), () => checkPlanFreshness(root, plan));

    // Assert
    expect(findings.map((finding) => finding.path)).toEqual(["toolchain:node"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("allowlisted tools are probed: bun from the running runtime, git from PATH", async () => {
    // Arrange
    const root = scratchProject();
    const old = await planWith(root, { id: "bun", minVersion: "0.1.0", reason: "x" });
    const newer = await planWith(root, { id: "bun", minVersion: "999.0.0", reason: "x" });
    const git = await planWith(root, { id: "git", minVersion: "1.0.0", reason: "x" });

    // Act
    const oldFindings = await checkPlanFreshness(root, old);
    const newerFindings = await checkPlanFreshness(root, newer);
    const gitFindings = await checkPlanFreshness(root, git);

    // Assert
    expect(oldFindings).toEqual([]);
    expect(newerFindings.map((finding) => finding.actual)).toEqual([Bun.version]);
    expect(gitFindings).toEqual([]);
  });
});
