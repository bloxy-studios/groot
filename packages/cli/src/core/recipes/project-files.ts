/**
 * Project-file conventions shared by the recipes:
 *
 * - local env files and SQLite data must never be committable: before Groot
 *   writes them, the repository's own .gitignore files must ignore them —
 *   machine-local rules (core.excludesFile, .git/info/exclude) don't count,
 *   teammates don't have them — otherwise the nearest .gitignore gets the
 *   missing lines (planned before any env write);
 * - a tracked .env.local is refused outright — ignoring a tracked file does
 *   not untrack it, and Groot won't put a secret where git will commit it;
 * - .env.example carries placeholders only (exact preview);
 * - .env.local may already hold the developer's own secrets, so its edit is
 *   computed at apply time and its content never enters a plan, and a
 *   generated secret is written by a dedicated env.secret step whose value is
 *   never part of the plan, journal, or output. Whether a name is assigned is
 *   read exactly as the executor reads it (core/executor/secrets.ts), and
 *   what the assignment holds as Bun loads it (./dotenv.ts), so a plan never
 *   promises a value the executor would decline to write, nor keeps one the
 *   app would load as empty.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { GrootV2Error } from "../errors.ts";
import { hasEnvAssignment } from "../executor/secrets.ts";
import { joinRel, resolveInProject } from "../fs/paths.ts";
import { git } from "../git.ts";
import type { PlanBuilder } from "../planner/builder.ts";
import { dotenvValues } from "./dotenv.ts";
import type { RecipeLayout } from "./layout.ts";

export interface IgnoreTarget {
  /** What the plan says it ignores. */
  readonly label: string;
  /** Project-relative paths that must all be ignored for the target to count as ignored. */
  readonly probes: readonly string[];
  /** The .gitignore line that ignores them, given the .gitignore's directory. */
  readonly line: (gitignoreDir: string) => string;
}

/** `.env.local` anywhere below the .gitignore — never committed. */
export function envLocalTarget(layout: RecipeLayout): IgnoreTarget {
  return { label: layout.envLocal, probes: [layout.envLocal], line: () => ".env.local" };
}

/** A SQLite database and its sidecars: WAL mode's -wal/-shm, the rollback -journal — all hold rows. */
const SQLITE_FILES = ["", "-wal", "-shm", "-journal"];

/** A literal path as a .gitignore pattern (glob characters escaped). */
function gitignoreLiteral(path: string): string {
  return path.replace(/[*?[\\]/g, "\\$&");
}

/** The app's default SQLite directory (DATABASE_URL=./data/app.db), anchored to its app. */
export function dataDirTarget(layout: RecipeLayout): IgnoreTarget {
  const dataDir = joinRel(layout.appDir, "data");
  const database = joinRel(dataDir, "app.db");
  return {
    label: `${dataDir}/ (the SQLite database and its -wal/-shm/-journal files)`,
    probes: SQLITE_FILES.map((suffix) => `${database}${suffix}`),
    line: (gitignoreDir) => `/${gitignoreLiteral(posix.relative(gitignoreDir, dataDir))}/`,
  };
}

/**
 * Is `path` ignored by the repository's own .gitignore files? The deciding
 * rule must come from a .gitignore inside the repository: git reports
 * core.excludesFile by absolute path (whatever its name) and
 * .git/info/exclude by name, and neither travels with a clone. A negated
 * rule (`!x`) decides "not ignored" even though --verbose exits 0. Output
 * that can't be read (e.g. a quoted exotic path) counts as not ignored, so
 * the line gets added. null = not a git repository.
 */
export async function ignoredByRepository(root: string, path: string): Promise<boolean | null> {
  const result = await git(root, ["check-ignore", "--verbose", "--", path]);
  if (result.exitCode === 1) return false;
  if (result.exitCode !== 0) return null;
  // <source>:<line>:<pattern><TAB><path>
  const match = /^(.*?):\d+:(.*)\t/.exec(result.stdout);
  if (match === null) return false;
  const [, source = "", pattern = ""] = match;
  const repositoryFile =
    !isAbsolute(source) && !source.startsWith("/") && posix.basename(source) === ".gitignore";
  return repositoryFile && !pattern.startsWith("!");
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
    for (const probe of target.probes) {
      // null = not a git repository: nothing proves it's ignored, so add the line.
      if ((await ignoredByRepository(root, probe)) === true) continue;
      missing.push(target);
      break;
    }
  }
  if (missing.length === 0) return [];
  const gitignore = await nearestGitignore(builder, appDir);
  const lines = missing.map((target) => target.line(posix.dirname(gitignore)));
  await builder.editFile({
    path: gitignore,
    edit: { kind: "lines", lines, header: IGNORE_HEADER },
    description: `ignore ${missing.map((target) => target.label).join(" and ")} in ${gitignore}`,
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

/** The dotenv file's text, or null when it doesn't exist (never part of a plan). */
function envText(root: string, path: string): string | null {
  try {
    return readFileSync(resolveInProject(root, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * Non-secret local values in .env.local. Deferred: the file may already hold
 * the developer's secrets, so the edit (missing names only) is computed at
 * apply time and the file's content never appears in the plan. Names the file
 * already assigns are left out — re-planning an applied recipe edits nothing.
 */
export async function addEnvLocal(
  builder: PlanBuilder,
  root: string,
  layout: RecipeLayout,
  wanted: readonly EnvEntry[],
  recipeId: string,
): Promise<void> {
  const current = envText(root, layout.envLocal);
  const entries = wanted.filter(
    (entry) => current === null || !hasEnvAssignment(current, entry.name),
  );
  if (entries.length === 0) return;
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
 * How .env.local holds `name` (the value itself never leaves this function):
 * "set" when Bun loads a non-blank value for it (a `$NAME` reference counts —
 * Bun expands it from the environment the app starts in); "empty" when Bun
 * loads nothing usable (`NAME=`, empty quotes, only a `# comment`) yet the
 * executor's env.secret step reads a `NAME=` line there and keeps it as it
 * stands; "absent" otherwise — then the step appends an assignment, which Bun
 * reads last, so it wins.
 */
function secretAssignment(root: string, path: string, name: string): "absent" | "empty" | "set" {
  const text = envText(root, path);
  if (text === null) return "absent";
  const loaded = dotenvValues(text).get(name);
  if (loaded !== undefined && loaded.trim() !== "") return "set";
  return hasEnvAssignment(text, name) ? "empty" : "absent";
}

/**
 * Generate a local secret into .env.local unless the developer already set
 * one (the value is never read into the plan). Returns false when an existing
 * value is kept. An assignment Bun loads as blank (`NAME=`, `NAME=""`,
 * `NAME= # comment`) is refused: the executor keeps every assignment as it
 * stands, so planning a generated secret there would promise a value that
 * never gets written, and keeping it would leave the app without a secret.
 */
export async function addSecret(
  builder: PlanBuilder,
  root: string,
  layout: RecipeLayout,
  name: string,
): Promise<boolean> {
  const assignment = secretAssignment(root, layout.envLocal, name);
  if (assignment === "set") return false;
  if (assignment === "empty") {
    throw new GrootV2Error(
      "GROOT_E_CONFLICT",
      `${layout.envLocal} assigns ${name}, but Bun loads it as empty (a blank value, empty quotes, or only a # comment); Groot generates a secret only where none is assigned and never rewrites an assignment.`,
      {
        hint: `Delete that ${name} line (Groot then generates one), or set a value yourself (>= 32 random characters, e.g. openssl rand -base64 32), then plan again.`,
        details: { path: layout.envLocal, conflict: "empty-env-value", name },
      },
    );
  }
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
