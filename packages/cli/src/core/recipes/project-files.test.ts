/**
 * Project-file conventions against real git repositories: what must stay
 * uncommittable is judged by the repository's own .gitignore files (never by
 * a developer's machine-local rules), SQLite's sidecar files count along with
 * the database, and the test applier treats an existing env assignment
 * exactly like the executor's env.secret step does.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationPlan } from "../contracts/plan.ts";
import { hasEnvAssignment } from "../executor/secrets.ts";
import { PlanBuilder } from "../planner/builder.ts";
import { createdWith } from "../runtime.ts";
import { appFixture } from "../test-fixtures.ts";
import { dataDrizzleSqlite } from "./data/recipe.ts";
import { recipeLayout } from "./layout.ts";
import { dataDirTarget, ignoredByRepository } from "./project-files.ts";
import { materializePlan } from "./testing/apply.ts";
import { planBoth, removeScratchDirs, scratchDir, singleApp } from "./testing/fixtures.ts";
import { writeFiles } from "./testing/projects.ts";

const TIMEOUT = 60_000;

afterAll(removeScratchDirs);

function gitIn(root: string, args: readonly string[]): number {
  return Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })
    .exitCode;
}

/** Ignored by any rule git applies here (machine-local ones included). */
const ignored = (root: string, path: string): boolean =>
  gitIn(root, ["check-ignore", "-q", "--", path]) === 0;

function ignoreLines(plan: OperationPlan): string[] {
  return plan.actions.flatMap((action) =>
    action.type === "file.edit" && action.edit.kind === "lines" ? action.edit.lines : [],
  );
}

describe("ignore rules", () => {
  test("only a .gitignore inside the repository counts; negations, global and info/exclude rules don't", async () => {
    // Arrange
    const root = scratchDir("ignore-sources");
    if (gitIn(root, ["init", "-q", "-b", "main"]) !== 0) throw new Error("git init failed");
    writeFiles(root, {
      ".gitignore": "*.log\n!keep.log\nrepo-only.txt\n",
      "sub dir/.gitignore": "nested.txt\n",
    });
    // A global excludes file named .gitignore is still machine-local (git reports it by absolute path).
    const globalIgnore = join(scratchDir("global"), ".gitignore");
    writeFileSync(globalIgnore, "global-only.txt\nkeep.log\n");
    gitIn(root, ["config", "core.excludesFile", globalIgnore]);
    appendFileSync(join(root, ".git/info/exclude"), "info-only.txt\n");
    const outside = scratchDir("not-a-repo");
    // Act
    const verdicts = await Promise.all(
      [
        "repo-only.txt",
        "x.log",
        "sub dir/nested.txt",
        "keep.log",
        "global-only.txt",
        "info-only.txt",
        "plain.txt",
      ].map(async (path) => [path, await ignoredByRepository(root, path)] as const),
    );
    // Assert
    expect(verdicts).toEqual([
      ["repo-only.txt", true],
      ["x.log", true],
      ["sub dir/nested.txt", true],
      ["keep.log", false],
      ["global-only.txt", false],
      ["info-only.txt", false],
      ["plain.txt", false],
    ]);
    expect(await ignoredByRepository(outside, ".env.local")).toBeNull();
  });

  test("an app directory with glob characters is ignored literally, not as a pattern", async () => {
    // Arrange
    const root = scratchDir("glob-app");
    if (gitIn(root, ["init", "-q", "-b", "main"]) !== 0) throw new Error("git init failed");
    const app = appFixture({ id: "api", path: "apps/[v1]", entry: "src/index.ts" });
    const layout = recipeLayout(app, undefined);
    if (layout === null) throw new Error("the fixture layout must resolve");
    // Act
    const line = dataDirTarget(layout).line("apps");
    writeFiles(root, { "apps/.gitignore": `${line}\n` });
    // Assert
    expect(line).toBe("/\\[v1]/data/");
    expect(await ignoredByRepository(root, "apps/[v1]/data/app.db-wal")).toBe(true);
    expect(await ignoredByRepository(root, "apps/v/data/app.db")).toBe(false);
  });

  test(
    "`*.db` already ignoring app.db still gets /data/: SQLite's -wal/-shm/-journal files hold rows too",
    async () => {
      // Arrange
      const fx = await singleApp((root) =>
        writeFileSync(join(root, ".gitignore"), "node_modules/\n*.db\n.env.local\n"),
      );
      // Act
      const { plan } = await planBoth(fx, [dataDrizzleSqlite]);
      await materializePlan(fx.root, plan);
      // Assert
      expect(ignoreLines(plan)).toEqual(["/data/"]);
      for (const file of ["app.db", "app.db-wal", "app.db-shm", "app.db-journal"]) {
        expect([file, ignored(fx.root, `data/${file}`)]).toEqual([file, true]);
      }
    },
    TIMEOUT,
  );

  test.each([
    [
      "a global excludes file (core.excludesFile)",
      (root: string): void => {
        const excludes = join(scratchDir("excludes"), "ignore");
        writeFileSync(excludes, ".env.local\ndata/\n");
        if (gitIn(root, ["config", "core.excludesFile", excludes]) !== 0) {
          throw new Error("git config core.excludesFile failed");
        }
      },
    ],
    [
      ".git/info/exclude",
      (root: string): void =>
        appendFileSync(join(root, ".git/info/exclude"), ".env.local\ndata/\n"),
    ],
  ])(
    "rules only in %s don't count: the repository's .gitignore still gets the lines",
    async (_where, addMachineLocalRules) => {
      // Arrange
      const fx = await singleApp();
      addMachineLocalRules(fx.root);
      expect(ignored(fx.root, ".env.local")).toBe(true);
      // Act
      const { plan } = await planBoth(fx, [dataDrizzleSqlite]);
      await materializePlan(fx.root, plan);
      // Assert
      expect(ignoreLines(plan)).toEqual([".env.local", "/data/"]);
      expect(readFileSync(join(fx.root, ".gitignore"), "utf8")).toContain("\n.env.local\n/data/\n");
    },
    TIMEOUT,
  );
});

/** A plan with one env.secret step, built the way planners build plans. */
function secretOnlyPlan(root: string): OperationPlan {
  const builder = new PlanBuilder({
    root,
    intent: {
      type: "add-capability",
      capabilities: ["auth"],
      target: "api",
      recipe: null,
      options: {},
    },
    summary: "generate a local BETTER_AUTH_SECRET",
    topology: "single",
    revision: { vcs: "none", head: null, branch: null, dirty: false, worktreeFingerprint: null },
    createdWith: createdWith(),
  });
  builder.add({
    type: "env.secret",
    path: ".env.local",
    name: "BETTER_AUTH_SECRET",
    generator: "random-secret",
    description: "generate a local BETTER_AUTH_SECRET into .env.local",
    classes: ["fs.edit"],
    reversible: true,
    compensation: "remove BETTER_AUTH_SECRET from .env.local if the file is unchanged since apply",
  });
  return builder.build();
}

describe("env.secret in the test applier", () => {
  test.each([
    ["no assignment", "OTHER=1\n"],
    ["an empty placeholder", "BETTER_AUTH_SECRET=\n"],
    ["a value the developer set", "BETTER_AUTH_SECRET=chosen-by-the-developer-0123456789\n"],
  ])("%s: kept or appended exactly as the executor's env.secret step decides", async (_case, text) => {
    // Arrange
    const root = scratchDir("secret");
    writeFileSync(join(root, ".env.local"), text);
    const executorKeeps = hasEnvAssignment(text, "BETTER_AUTH_SECRET");
    // Act
    const applied = await materializePlan(root, secretOnlyPlan(root));
    // Assert
    const after = readFileSync(join(root, ".env.local"), "utf8");
    expect(after === text).toBe(executorKeeps);
    expect(applied.secrets).toHaveLength(executorKeeps ? 0 : 1);
  });
});
