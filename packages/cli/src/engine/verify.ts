/**
 * Verify stage (docs/architecture.md#5-verify): structural workspace checks, the
 * root install, and git initialization. Deeper per-package checks (typecheck,
 * boot) arrive with `groot doctor` in v0.3.
 *
 * Failures throw EXIT.STITCH (stage 4–5 failures leave the tree in place).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, GrootError } from "./errors.ts";
import { runCommand } from "./run.ts";
import type { Plan } from "./types.ts";

/** Parse-and-uniqueness checks across every workspace package.json. */
export async function verifyStructure(plan: Plan): Promise<string[]> {
  const notes: string[] = [];
  const seen = new Map<string, string>();

  const paths = ["package.json", ...plan.scaffolds.map((s) => join(s.path, "package.json"))];
  for (const relPath of paths) {
    const absPath = join(plan.targetDir, relPath);
    if (!existsSync(absPath)) {
      throw new GrootError(`Verify failed: missing ${relPath}`, EXIT.STITCH);
    }
    let name: unknown;
    try {
      name = (JSON.parse(await readFile(absPath, "utf8")) as Record<string, unknown>).name;
    } catch {
      throw new GrootError(`Verify failed: ${relPath} is not valid JSON`, EXIT.STITCH);
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new GrootError(`Verify failed: ${relPath} has no package name`, EXIT.STITCH);
    }
    const previous = seen.get(name);
    if (previous !== undefined && relPath !== "package.json") {
      throw new GrootError(
        `Verify failed: duplicate package name "${name}" (${previous} and ${relPath})`,
        EXIT.STITCH,
      );
    }
    seen.set(name, relPath);
  }
  notes.push(`workspace structure OK (${paths.length} packages)`);
  return notes;
}

export interface VerifyOptions {
  readonly verbose: boolean;
  readonly onStep?: (label: string) => void;
}

/**
 * Electron's runtime arrives via a postinstall script that bun blocks for
 * untrusted packages — and in workspaces, bun does not reliably honor the
 * root trustedDependencies grant for a workspace member's dependencies
 * (verified empirically in the flagship E2E: the grant was present, the
 * runtime still didn't download). `bun pm trust` is bun's own retroactive
 * path: it runs the scripts it previously blocked. Only invoked when the
 * plan has an electron scaffold and the runtime is actually missing; a
 * failure here degrades to a note — doctor carries the persistent warning.
 */
async function runBlockedElectronPostinstall(
  plan: Plan,
  options: VerifyOptions,
): Promise<string[]> {
  if (!plan.scaffolds.some((scaffold) => scaffold.framework === "electron")) return [];
  const electronPkg = join(plan.targetDir, "node_modules", "electron");
  if (!existsSync(electronPkg) || existsSync(join(electronPkg, "dist"))) return [];
  const report = options.onStep ?? (() => {});
  report("Running electron's blocked postinstall (bun pm trust)");
  try {
    await runCommand(
      {
        argv: ["bun", "pm", "trust", "electron"],
        cwd: plan.targetDir,
        label: "bun pm trust electron",
      },
      { verbose: options.verbose },
    );
  } catch {
    // Fall through to the state check — doctor's fix hint covers the rest.
  }
  return existsSync(join(electronPkg, "dist"))
    ? ["electron runtime downloaded (bun pm trust electron)"]
    : ["electron runtime still missing — run `bun pm trust electron` at the workspace root"];
}

/** Structural checks → root bun install → git init + initial commit. */
export async function verify(plan: Plan, options: VerifyOptions): Promise<string[]> {
  const report = options.onStep ?? (() => {});
  const notes = await verifyStructure(plan);

  if (plan.options.install) {
    report("Installing workspace (bun install)");
    try {
      await runCommand(
        { argv: ["bun", "install"], cwd: plan.targetDir, label: "bun install" },
        { verbose: options.verbose },
      );
      notes.push("bun install OK (root bun.lock written)");
    } catch (error) {
      // Re-tag: an install failure at this stage is a workspace problem, not a generator one.
      const message = error instanceof Error ? error.message : String(error);
      throw new GrootError(
        message,
        EXIT.STITCH,
        "The workspace files are in place — fix and re-run `bun install` manually.",
      );
    }
    notes.push(...(await runBlockedElectronPostinstall(plan, options)));
  }

  if (plan.options.git && !existsSync(join(plan.targetDir, ".git"))) {
    report("Initializing git repository");
    await runCommand(
      { argv: ["git", "init", "-b", "main"], cwd: plan.targetDir, label: "git init" },
      { verbose: options.verbose },
    );
    const add = Bun.spawn(["git", "add", "-A"], {
      cwd: plan.targetDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await add.exited;
    // The initial commit needs a local git identity; its absence must not fail the run.
    const commit = Bun.spawn(["git", "commit", "-q", "-m", "feat: plant groot workspace 🌱"], {
      cwd: plan.targetDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await commit.exited) === 0) {
      notes.push("git repository initialized with an initial commit");
    } else {
      notes.push(
        "git initialized; initial commit skipped (configure git user.name/user.email and commit manually)",
      );
    }
  }

  return notes;
}
