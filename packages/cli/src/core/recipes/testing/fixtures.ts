/**
 * Ready-made planning fixtures for the recipe unit tests (never imported by
 * runtime code): a real temporary project on disk (git-initialized, so
 * check-ignore and dirty-path detection are real) plus the blueprint app and
 * observation a planner would hand to the recipes.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintApp, BlueprintV2 } from "../../contracts/blueprint.ts";
import type { ProjectObservation } from "../../contracts/project.ts";
import { appFixture, blueprintFixture } from "../../test-fixtures.ts";
import { authBetterAuth } from "../auth/recipe.ts";
import { dataDrizzleSqlite } from "../data/recipe.ts";
import type { Recipe } from "../types.ts";
import { observeUnit, type PlannedRecipes, planRecipes } from "./plan.ts";
import {
  ADOPTED_MAIN,
  commitAll,
  writeAdoptedProject,
  writeCreateHonoApp,
  writeWorkspaceRoot,
} from "./projects.ts";

export interface PlanningFixture {
  readonly root: string;
  readonly app: BlueprintApp;
  readonly blueprint: BlueprintV2;
  readonly observation: ProjectObservation;
}

export const BOTH: readonly Recipe[] = [dataDrizzleSqlite, authBetterAuth];

const created: string[] = [];

/** A fresh temporary directory, removed by removeScratchDirs() (call it from afterAll). */
export function scratchDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `groot-recipe-${name}-`));
  created.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

async function fixture(
  root: string,
  app: BlueprintApp,
  topology: "single" | "monorepo",
  origin: "created" | "adopted",
): Promise<PlanningFixture> {
  const blueprint = blueprintFixture({
    project: { name: "fixture", topology, packageManager: "bun", origin },
    apps: [app],
  });
  return { root, app, blueprint, observation: await observeUnit(root, app, topology) };
}

/** create-hono single app at the project root (entry src/index.ts, Bun's default port). */
export async function singleApp(edit?: (root: string) => void): Promise<PlanningFixture> {
  const root = scratchDir("single");
  writeCreateHonoApp(root, "app");
  edit?.(root);
  commitAll(root);
  const app = appFixture({
    id: "api",
    path: ".",
    port: 3000,
    entry: "src/index.ts",
    origin: "generated",
  });
  return fixture(root, app, "single", "created");
}

/** Bun workspace with apps/api from create-hono. */
export async function monorepo(): Promise<PlanningFixture> {
  const root = scratchDir("mono");
  writeWorkspaceRoot(root, "mono");
  writeCreateHonoApp(join(root, "apps/api"), "api");
  commitAll(root);
  const app = appFixture({
    id: "api",
    path: "apps/api",
    port: 3000,
    entry: "src/index.ts",
    origin: "generated",
  });
  return fixture(root, app, "monorepo", "created");
}

export const DIRTY_ROUTE = 'api.get("/version", (c) => c.text("0.3.0"));';

/** Adopted custom layout; `dirty` leaves an uncommitted human edit and an untracked file. */
export async function adoptedApp(
  options: { dirty: boolean } = { dirty: false },
): Promise<PlanningFixture> {
  const root = scratchDir("adopted");
  writeAdoptedProject(root);
  commitAll(root);
  if (options.dirty) {
    const main = join(root, "server/main.ts");
    writeFileSync(
      main,
      readFileSync(main, "utf8").replace(
        'api.get("/", (c) => c.json({ service: "acme-notes-api", ok: true }));',
        `api.get("/", (c) => c.json({ service: "acme-notes-api", ok: true }));\n${DIRTY_ROUTE}`,
      ),
    );
    appendFileSync(join(root, "NOTES.md"), "scratch notes, not committed\n");
  }
  const app = appFixture({
    id: "api",
    path: ".",
    port: 4310,
    entry: "server/main.ts",
    origin: "adopted",
  });
  return fixture(root, app, "single", "adopted");
}

/** The adopted entry as the human last saved it (dirty variant included). */
export function adoptedMain(dirty: boolean): string {
  return dirty
    ? ADOPTED_MAIN.replace(
        'api.get("/", (c) => c.json({ service: "acme-notes-api", ok: true }));',
        `api.get("/", (c) => c.json({ service: "acme-notes-api", ok: true }));\n${DIRTY_ROUTE}`,
      )
    : ADOPTED_MAIN;
}

export function planBoth(
  fx: PlanningFixture,
  recipes: readonly Recipe[] = BOTH,
): Promise<PlannedRecipes> {
  return planRecipes({ ...fx, recipes });
}
