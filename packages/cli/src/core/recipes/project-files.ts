/**
 * Project-file conventions shared by the recipes:
 *
 * - local env files and SQLite data must never be committable: before Groot
 *   writes them, `git check-ignore` must say they are ignored, otherwise the
 *   nearest .gitignore gets the missing lines (planned before any env write);
 * - a tracked .env.local is refused outright — ignoring a tracked file does
 *   not untrack it, and Groot won't put a secret where git will commit it;
 * - .env.example carries placeholders only (exact preview);
 * - .env.local may already hold the developer's own secrets, so its edit is
 *   computed at apply time and its content never enters a plan, and a
 *   generated secret is written by a dedicated env.secret step whose value is
 *   never part of the plan, journal, or output.
 */
import { posix } from "node:path";
import { envNamesIn, isGitIgnored } from "../env.ts";
import { GrootV2Error } from "../errors.ts";
import { joinRel } from "../fs/paths.ts";
import { git } from "../git.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import type { RecipeLayout } from "./layout.ts";

export interface IgnoreTarget {
  /** Project-relative path that must be ignored. */
  readonly path: string;
  /** The .gitignore line that ignores it, given the .gitignore's directory. */
  readonly line: (gitignoreDir: string) => string;
}

/** `.env.local` anywhere below the .gitignore — never committed. */
export function envLocalTarget(layout: RecipeLayout): IgnoreTarget {
  return { path: layout.envLocal, line: () => ".env.local" };
}

/** The app's default SQLite directory (DATABASE_URL=./data/app.db), anchored to its app. */
export function dataDirTarget(layout: RecipeLayout): IgnoreTarget {
  const dataDir = joinRel(layout.appDir, "data");
  return {
    path: joinRel(dataDir, "app.db"),
    line: (gitignoreDir) => `/${posix.relative(gitignoreDir, dataDir)}/`,
  };
}

const IGNORE_HEADER = "# Groot: local env files and SQLite data — never commit";

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  while (current !== "." && current !== "") {
    out.push(current);
    current = posix.dirname(current);
  }
  out.push(".");
  return out;
}

/** The closest existing .gitignore from the app up to the project root (else the app's own). */
async function nearestGitignore(builder: PlanBuilder, appDir: string): Promise<string> {
  for (const dir of ancestors(appDir)) {
    const path = joinRel(dir, ".gitignore");
    if ((await builder.currentContent(path)) !== null) return path;
  }
  return joinRel(appDir, ".gitignore");
}

/** Plan the .gitignore lines for every target git doesn't already ignore. Returns the lines added. */
export async function ensureIgnored(
  builder: PlanBuilder,
  root: string,
  appDir: string,
  targets: readonly IgnoreTarget[],
  recipeId: string,
): Promise<string[]> {
  const missing: IgnoreTarget[] = [];
  for (const target of targets) {
    // null = not a git repository: nothing proves it's ignored, so add the line.
    if ((await isGitIgnored(root, target.path)) !== true) missing.push(target);
  }
  if (missing.length === 0) return [];
  const gitignore = await nearestGitignore(builder, appDir);
  const lines = missing.map((target) => target.line(posix.dirname(gitignore)));
  await builder.editFile({
    path: gitignore,
    edit: { kind: "lines", lines, header: IGNORE_HEADER },
    description: `ignore ${missing.map((target) => target.path).join(" and ")} in ${gitignore}`,
    owns: lines,
    createIfMissing: true,
  });
  builder.own({
    path: gitignore,
    owner: "shared",
    parts: lines,
    note: `${recipeId} added these ignore lines; the rest of the file is yours`,
  });
  return lines;
}

/** Refuse to plan secrets/config into an env file git tracks. */
export async function assertUntracked(root: string, path: string, recipeId: string): Promise<void> {
  const result = await git(root, ["ls-files", "--error-unmatch", "--", path]);
  if (result.exitCode !== 0) return;
  throw new GrootV2Error(
    "GROOT_E_CONFLICT",
    `${path} is tracked by git; ${recipeId} won't write local configuration or secrets into a committed file.`,
    {
      hint: `Untrack it (git rm --cached ${path}), keep it gitignored, then plan again.`,
      details: { path, conflict: "tracked-env-file" },
    },
  );
}

export interface EnvEntry {
  readonly name: string;
  readonly value: string;
  readonly comment: string | null;
}

/** Placeholder entries in .env.example (committed; exact preview). */
export async function addEnvExample(
  builder: PlanBuilder,
  layout: RecipeLayout,
  entries: readonly EnvEntry[],
  recipeId: string,
): Promise<void> {
  await builder.editFile({
    path: layout.envExample,
    edit: { kind: "env", entries: [...entries] },
    description: `document ${entries.map((entry) => entry.name).join(", ")} in ${layout.envExample} (placeholders only)`,
    owns: entries.map((entry) => entry.name),
    createIfMissing: true,
  });
  builder.own({
    path: layout.envExample,
    owner: "shared",
    parts: entries.map((entry) => entry.name),
    note: `${recipeId} documents these variables; values are placeholders`,
  });
}

/**
 * Non-secret local values in .env.local. Deferred: the file may already hold
 * the developer's secrets, so the edit (missing names only) is computed at
 * apply time and the file's content never appears in the plan.
 */
export async function addEnvLocal(
  builder: PlanBuilder,
  layout: RecipeLayout,
  entries: readonly EnvEntry[],
  recipeId: string,
): Promise<void> {
  await builder.editFile({
    path: layout.envLocal,
    edit: { kind: "env", entries: [...entries] },
    description: `set local ${entries.map((entry) => entry.name).join(", ")} in ${layout.envLocal} unless already set (gitignored)`,
    owns: entries.map((entry) => entry.name),
    createIfMissing: true,
    deferred: true,
  });
  builder.own({
    path: layout.envLocal,
    owner: "shared",
    parts: entries.map((entry) => entry.name),
    note: `${recipeId} adds missing local values; existing values are never changed`,
  });
  builder.assume(
    `${layout.envLocal} is edited at apply time (only missing names are added); its content never enters the plan because it may hold secrets.`,
  );
}

/**
 * Generate a local secret into .env.local unless the developer already set
 * one (checked by name only — the value is never read into the plan).
 * Returns false when an existing value is kept.
 */
export async function addSecret(
  builder: PlanBuilder,
  root: string,
  layout: RecipeLayout,
  name: string,
): Promise<boolean> {
  if (envNamesIn(root, layout.envLocal).has(name)) return false;
  const expect = await builder.expectationFor(layout.envLocal);
  builder.add({
    type: "env.secret",
    path: layout.envLocal,
    name,
    generator: "random-secret",
    description: `generate a local ${name} into ${layout.envLocal} (gitignored; the value never enters the plan)`,
    classes: [expect.state === "absent" ? "fs.create" : "fs.edit"],
    reversible: true,
    compensation: `remove ${name} from ${layout.envLocal} if the file is unchanged since apply`,
  });
  return true;
}
