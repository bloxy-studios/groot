/**
 * build.bundle — `bun build <entry> --target bun` into a throwaway directory.
 * Bundling resolves and transpiles the whole import graph from the server
 * entry: the recipe's modules, the mount regions, and every package subpath
 * they import from node_modules (e.g. better-auth/minimal, the bun-sqlite
 * migrator) — so a missing module or a broken import fails here, offline and
 * without starting anything. It runs whether or not the app has its own build
 * or typecheck script; it does not typecheck (build.typecheck does, where the
 * app has a typecheck script or a local tsc).
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, tail } from "../../process.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import {
  blockedOnInstall,
  failure,
  isOutcome,
  locateUnit,
  missingPackages,
  type UnitUnderTest,
} from "./harness.ts";

const TOOL = "build.bundle";
const BUNDLE_TIMEOUT_MS = 300_000;

function outputSize(dir: string): { files: number; bytes: number } {
  const names = readdirSync(dir, { recursive: true }) as string[];
  const files = names.map((name) => join(dir, name)).filter((path) => statSync(path).isFile());
  return { files: files.length, bytes: files.reduce((sum, path) => sum + statSync(path).size, 0) };
}

async function bundle(
  input: CheckInput,
  unit: UnitUnderTest,
  entry: string,
): Promise<CheckOutcome> {
  const out = mkdtempSync(join(tmpdir(), "groot-bundle-"));
  try {
    const argv = ["bun", "build", entry, "--target", "bun", "--outdir", out];
    const result = await runProcess({
      argv,
      cwd: unit.dir,
      env: input.ctx.env,
      timeoutMs: BUNDLE_TIMEOUT_MS,
      signal: input.ctx.signal,
    });
    const log = `${result.stdout}\n${result.stderr}`;
    // The temporary path is meaningless in evidence; record a stable placeholder.
    const shown = [...argv.slice(0, -1), "<temporary directory>"];
    const method = {
      kind: "command" as const,
      tool: TOOL,
      command: { argv: shown, cwd: unit.path, exitCode: result.exitCode },
    };
    const artifacts = [{ name: "bundle.log", kind: "log" as const, content: log }];
    if (result.aborted) {
      return {
        status: "skipped",
        summary: "bundle cancelled",
        method,
        artifacts,
        reason: "cancelled",
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "fail",
        summary: `bun build failed for ${entry} (exit ${result.exitCode ?? result.signal}): ${tail(log, 3)}`,
        method,
        artifacts,
        nextStep: "Fix the import or syntax error shown in bundle.log.",
      };
    }
    const size = outputSize(out);
    return {
      status: "pass",
      summary: `bun build bundled ${entry} for the bun target — every import resolved (${size.files} file(s), ${Math.round(size.bytes / 1024)} KiB, ${result.durationMs} ms)`,
      method,
      artifacts,
      details: { entry, files: size.files, bytes: size.bytes, durationMs: result.durationMs },
      limitations: ["bundling resolves and transpiles every import but does not typecheck"],
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function bundleCheck(input: CheckInput): Promise<CheckOutcome> {
  const unit = locateUnit(input, TOOL);
  if (isOutcome(unit)) return unit;
  if (unit.app.entry === null) {
    return failure(TOOL, `${unit.path} has no recorded server entry to bundle`);
  }
  const missing = missingPackages(input.root, unit);
  if (missing.length > 0) return blockedOnInstall(TOOL, unit, missing);
  return bundle(input, unit, unit.app.entry);
}
