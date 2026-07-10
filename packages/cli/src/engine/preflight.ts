/**
 * Preflight stage: validate the environment and target directory before anything
 * is written (docs/architecture.md#2-preflight). Dry runs execute read-only checks
 * and never create directories.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import type { DirConflictPolicy, Plan, PreflightCheck } from "./types.ts";

/** Minimum Bun version required to run scaffolded workspaces. */
export const MIN_BUN_VERSION = "1.2.0";

/** Loose semver comparison: is `current` >= `minimum`? (release segments only). */
export function versionAtLeast(current: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split("-")[0]
      ?.split(".")
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  const a = parse(current);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Does the path exist and contain at least one entry? */
async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return true; // a file in the way counts as a conflict
    const entries = await readdir(path);
    return entries.length > 0;
  } catch {
    return false; // doesn't exist → no conflict
  }
}

/**
 * Apply the --dir-conflict policy and return the directory the plan should use.
 * Never creates anything (safe for dry runs).
 */
export async function resolveDirConflict(
  targetDir: string,
  policy: DirConflictPolicy,
): Promise<string> {
  if (!(await isNonEmptyDir(targetDir))) return targetDir;

  switch (policy) {
    case "merge":
      return targetDir;
    case "increment": {
      const parent = dirname(targetDir);
      const base = basename(targetDir);
      for (let i = 1; i <= 99; i++) {
        const candidate = join(parent, `${base}-${i}`);
        if (!(await isNonEmptyDir(candidate))) return candidate;
      }
      throw new GrootError(
        `Could not find a free directory name for ${base} (tried ${base}-1 … ${base}-99)`,
        EXIT.PREFLIGHT,
      );
    }
    default:
      throw new GrootError(
        `Target directory is not empty: ${targetDir}`,
        EXIT.PREFLIGHT,
        "Choose how to proceed with --dir-conflict merge (write into it) or --dir-conflict increment (use a numbered sibling).",
      );
  }
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function registryReachable(timeoutMs = 5000): Promise<boolean> {
  try {
    const response = await fetch("https://registry.npmjs.org/-/ping", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface PreflightOptions {
  /** Read-only mode: skip the network probe (nothing will be downloaded). */
  readonly dryRun: boolean;
}

/**
 * Run all environment checks for a plan. Returns every check (for reporting) and
 * throws EXIT.PREFLIGHT when any fails.
 */
export async function runPreflight(
  plan: Plan,
  options: PreflightOptions,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  const bunOk = versionAtLeast(Bun.version, MIN_BUN_VERSION);
  checks.push({
    name: "bun",
    ok: bunOk,
    detail: bunOk ? `v${Bun.version}` : `v${Bun.version} — groot needs ≥ ${MIN_BUN_VERSION}`,
  });

  if (plan.options.git) {
    const gitOk = await commandAvailable("git", ["--version"]);
    checks.push({
      name: "git",
      ok: gitOk,
      detail: gitOk ? "available" : "not found — install git or pass --no-git",
    });
  }

  const needsNetwork = !options.dryRun && plan.scaffolds.some((s) => s.generator !== null);
  if (needsNetwork) {
    const online = await registryReachable();
    checks.push({
      name: "network",
      ok: online,
      detail: online ? "registry.npmjs.org reachable" : "cannot reach registry.npmjs.org",
    });
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new GrootError(
      `Preflight failed: ${failed.map((check) => `${check.name} (${check.detail})`).join(", ")}`,
      EXIT.PREFLIGHT,
    );
  }
  return checks;
}
