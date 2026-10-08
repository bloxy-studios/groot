/**
 * build.bundle — `bun build <entry> <recipe modules…> --target bun` into a
 * throwaway directory. Bundling resolves and transpiles whole import graphs:
 * the server entry (with the mount regions) and, as entrypoints of their own,
 * the recipe's modules — data's db/client.ts (→ schema.ts, sqlite.ts) and
 * db/migrate.ts, auth's auth.ts and route modules — so they are checked even
 * where the entry never imports them (a data-only app), together with every
 * package subpath they import from node_modules (e.g. better-auth/minimal,
 * the bun-sqlite migrator). A missing module or a broken import fails here,
 * offline and without starting anything. It runs whether or not the app has
 * its own build or typecheck script; it does not typecheck (build.typecheck
 * does, where the app has a typecheck script or a local tsc).
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, type SpawnResult, tail } from "../../process.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import { argPath, inSrc, type RecipeLayout, recipeLayout } from "../layout.ts";
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

/** The modules each capability's build check bundles next to the entry (paths relative to the app). */
export function recipeModules(capability: string | null, layout: RecipeLayout): string[] {
  if (capability === "data") {
    return [inSrc(layout, "db", "client.ts"), inSrc(layout, "db", "migrate.ts")];
  }
  if (capability === "auth") {
    return [
      inSrc(layout, "auth.ts"),
      inSrc(layout, "http", "auth-routes.ts"),
      inSrc(layout, "http", "notes-routes.ts"),
    ];
  }
  return [];
}

function outputSize(dir: string): { files: number; bytes: number } {
  const names = readdirSync(dir, { recursive: true }) as string[];
  const files = names.map((name) => join(dir, name)).filter((path) => statSync(path).isFile());
  return { files: files.length, bytes: files.reduce((sum, path) => sum + statSync(path).size, 0) };
}

interface Bundled {
  readonly entry: string;
  readonly modules: readonly string[];
}

/** The `bun build` command line (paths relative to the unit; "-…" paths written "./-…"). */
function bundleArgv(bundled: Bundled, outdir: string): string[] {
  const paths = [bundled.entry, ...bundled.modules].map(argPath);
  return ["bun", "build", ...paths, "--target", "bun", "--outdir", outdir];
}

function bundleOutcome(
  unit: UnitUnderTest,
  bundled: Bundled,
  result: SpawnResult,
  size: { files: number; bytes: number },
): CheckOutcome {
  const { entry, modules } = bundled;
  const log = `${result.stdout}\n${result.stderr}`;
  // The temporary output path is meaningless in evidence; record a stable placeholder.
  const argv = bundleArgv(bundled, "<temporary directory>");
  const method = {
    kind: "command" as const,
    tool: TOOL,
    command: { argv, cwd: unit.path, exitCode: result.exitCode },
  };
  const artifacts = [{ name: "bundle.log", kind: "log" as const, content: log }];
  const what = modules.length === 0 ? entry : `${entry} with ${modules.join(", ")}`;
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
      summary: `bun build failed for ${what} (exit ${result.exitCode ?? result.signal}): ${tail(log, 3)}`,
      method,
      artifacts,
      nextStep: "Fix the import or syntax error shown in bundle.log.",
    };
  }
  return {
    status: "pass",
    summary: `bun build bundled ${what} for the bun target — every import resolved (${size.files} file(s), ${Math.round(size.bytes / 1024)} KiB, ${result.durationMs} ms)`,
    method,
    artifacts,
    details: {
      entry,
      modules,
      files: size.files,
      bytes: size.bytes,
      durationMs: result.durationMs,
    },
    limitations: ["bundling resolves and transpiles every import but does not typecheck"],
  };
}

async function bundle(
  input: CheckInput,
  unit: UnitUnderTest,
  bundled: Bundled,
): Promise<CheckOutcome> {
  const out = mkdtempSync(join(tmpdir(), "groot-bundle-"));
  try {
    const result = await runProcess({
      argv: bundleArgv(bundled, out),
      cwd: unit.dir,
      env: input.ctx.env,
      timeoutMs: BUNDLE_TIMEOUT_MS,
      signal: input.ctx.signal,
    });
    return bundleOutcome(unit, bundled, result, outputSize(out));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function bundleCheck(input: CheckInput): Promise<CheckOutcome> {
  const unit = locateUnit(input, TOOL);
  if (isOutcome(unit)) return unit;
  const layout = recipeLayout(unit.app, undefined);
  if (unit.app.entry === null || layout === null) {
    return failure(TOOL, `${unit.path} has no recorded server entry to bundle`);
  }
  const missing = missingPackages(input.root, unit);
  if (missing.length > 0) return blockedOnInstall(TOOL, unit, missing);
  const modules = recipeModules(input.contract.capability, layout);
  return bundle(input, unit, { entry: unit.app.entry, modules });
}
