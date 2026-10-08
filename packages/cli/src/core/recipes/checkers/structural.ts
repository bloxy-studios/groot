/**
 * structural.recipe — offline, side-effect-free checks of one recipe on one
 * app, from what groot.lock.json says the recipe owns:
 *
 * - owned files exist (hand edits are reported, never treated as failures);
 * - owned managed regions exist and are well-formed (edits inside are noted);
 * - the recipe's pinned packages are still declared by the app;
 * - for the data/auth recipes: drizzle's migration journal is consistent —
 *   the recipe's own entries are present, every entry has its SQL file and
 *   snapshot, and the snapshots chain by prevId, so `db:generate` and
 *   `db:migrate` will both work from this state.
 *
 * Structural evidence proves the wiring is present; it never claims the app
 * runs (runtime and product-flow checks do that).
 */
import { existsSync, readFileSync } from "node:fs";
import type { RecipeLock } from "../../contracts/lock.ts";
import { hashFile } from "../../fs/hash.ts";
import { joinRel, resolveInProject } from "../../fs/paths.ts";
import { findRegions } from "../../transforms/regions.ts";
import type { CheckInput, CheckOutcome } from "../../verify/engine.ts";
import { AUTH_MIGRATION, DATA_MIGRATION, snapshotFileName, sqlFileName } from "../migrations.ts";
import { AUTH_RECIPE_ID, DATA_RECIPE_ID } from "../versions.ts";
import { failure, staticMethod } from "./harness.ts";

const TOOL = "structural.recipe";
const ROOT_SNAPSHOT = "00000000-0000-0000-0000-000000000000";

interface Findings {
  readonly problems: string[];
  readonly notes: string[];
}

const empty = (): Findings => ({ problems: [], notes: [] });

function merge(...all: Findings[]): Findings {
  return { problems: all.flatMap((f) => f.problems), notes: all.flatMap((f) => f.notes) };
}

async function artifactFindings(root: string, record: RecipeLock): Promise<Findings> {
  const found = empty();
  for (const artifact of record.artifacts) {
    const absolute = resolveInProject(root, artifact.path);
    const hash = await hashFile(absolute);
    if (hash === null) {
      found.problems.push(`${artifact.path} is missing`);
      continue;
    }
    if (artifact.ownership !== "region") {
      if (hash !== artifact.sha256)
        found.notes.push(`${artifact.path} was edited since Groot wrote it`);
      continue;
    }
    try {
      const regions = findRegions(readFileSync(absolute, "utf8"), artifact.path);
      for (const part of artifact.parts) {
        const region = regions.find((entry) => entry.id === part);
        if (region === undefined)
          found.problems.push(`${artifact.path} lost its managed region ${part}`);
        else if (!region.intact)
          found.notes.push(`${artifact.path}#${part} was edited inside its markers`);
      }
    } catch (error) {
      found.problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return found;
}

function dependencyFindings(root: string, appPath: string, record: RecipeLock): Findings {
  const found = empty();
  const path = joinRel(appPath, "package.json");
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(resolveInProject(root, path), "utf8"));
  } catch {
    return { problems: [`${path} is missing or unparseable`], notes: [] };
  }
  for (const [name, pinned] of Object.entries(record.dependencies)) {
    const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    if (declared === undefined) found.problems.push(`${name} is no longer declared in ${path}`);
    else if (declared !== pinned)
      found.notes.push(`${name} is ${declared} (the recipe pinned ${pinned})`);
  }
  return found;
}

interface JournalDoc {
  readonly entries?: { idx?: number; tag?: string }[];
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function journalFindings(root: string, appPath: string, record: RecipeLock): Findings {
  const found = empty();
  const drizzle = resolveInProject(root, joinRel(appPath, "drizzle"));
  const journal = readJson<JournalDoc>(`${drizzle}/meta/_journal.json`);
  if (journal === null || !Array.isArray(journal.entries)) {
    return {
      problems: [`${joinRel(appPath, "drizzle/meta/_journal.json")} is missing or unreadable`],
      notes: [],
    };
  }
  const own = record.recipe === DATA_RECIPE_ID ? DATA_MIGRATION : AUTH_MIGRATION;
  const atOwnIndex = journal.entries[own.entry.idx];
  if (atOwnIndex?.tag !== own.entry.tag) {
    found.problems.push(
      `the journal no longer lists ${own.entry.tag} at position ${own.entry.idx}`,
    );
  }
  let previous = ROOT_SNAPSHOT;
  for (const [index, raw] of journal.entries.entries()) {
    const entry = { idx: raw.idx ?? index, tag: raw.tag ?? "(untagged)" };
    if (!existsSync(`${drizzle}/${sqlFileName(entry)}`)) {
      found.problems.push(`migration ${entry.tag} has no SQL file`);
    }
    const snapshot = readJson<{ id?: string; prevId?: string }>(
      `${drizzle}/${snapshotFileName(entry)}`,
    );
    if (snapshot === null) {
      found.problems.push(`migration ${entry.tag} has no readable snapshot`);
      continue;
    }
    if (snapshot.prevId !== previous) {
      found.problems.push(
        `the snapshot of ${entry.tag} does not follow the previous one (prevId mismatch)`,
      );
    }
    previous = snapshot.id ?? "";
  }
  return found;
}

export async function structuralRecipeCheck(input: CheckInput): Promise<CheckOutcome> {
  const app = input.blueprint.apps.find((entry) => entry.path === input.contract.unit);
  if (app === undefined)
    return failure(TOOL, `no app at ${input.contract.unit ?? "(no unit)"} in groot.json`);
  if (input.lock === null) {
    return failure(
      TOOL,
      "groot.lock.json is missing — it records what the recipe owns",
      "Restore groot.lock.json (it is committed with groot.json).",
    );
  }
  const record = input.lock.recipes.find(
    (entry) => entry.capability === input.contract.capability && entry.target === app.id,
  );
  if (record === undefined) {
    return failure(
      TOOL,
      `groot.lock.json has no ${input.contract.capability ?? "recipe"} record for ${app.id}`,
    );
  }
  const usesJournal = record.recipe === DATA_RECIPE_ID || record.recipe === AUTH_RECIPE_ID;
  const found = merge(
    await artifactFindings(input.root, record),
    dependencyFindings(input.root, app.path, record),
    usesJournal ? journalFindings(input.root, app.path, record) : empty(),
  );
  const details = { recipe: record.recipe, problems: found.problems, notes: found.notes };
  if (found.problems.length > 0) {
    return {
      status: "fail",
      summary: `${record.recipe} on ${app.path}: ${found.problems.join("; ")}`,
      method: staticMethod(TOOL),
      details,
      nextStep: "Restore the missing pieces (git checkout), or re-plan the capability.",
    };
  }
  const deps = Object.keys(record.dependencies).length;
  return {
    status: "pass",
    summary: `${record.recipe} on ${app.path}: ${record.artifacts.length} owned artifact(s) present, ${deps} pinned package(s) declared${usesJournal ? ", migration journal consistent" : ""}${found.notes.length > 0 ? ` (noted: ${found.notes.join("; ")})` : ""}`,
    method: staticMethod(TOOL),
    details,
    limitations: found.notes.length > 0 ? ["hand edits are reported, never overwritten"] : [],
  };
}
