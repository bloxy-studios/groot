/**
 * The repository guard and Groot's own git, in real temp repositories (no
 * runners): what the guard reports (refs, hooks, config) and what it lets
 * move (other tasks' Groot branches, remote-tracking refs, Groot's own
 * journaled fast-forwards — never the task's own branches); Groot's git never
 * runs repository hooks; the dependency plan recognizes directory-only
 * node_modules patterns in a worktree that has no node_modules yet; and
 * Groot's commits never stage new files under node_modules.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dependencyPlan } from "./dependencies.ts";
import { commitAll, ensureWorktree, gitCommonDir } from "./git-ops.ts";
import {
  guardChanges,
  guardSnapshot,
  movedByGroot,
  type RefMove,
  readRefMoves,
  recordRefMove,
} from "./guard.ts";
import { removeTempProjects, type TempProject, tempProject } from "./testing/temp-project.ts";

const TIMEOUT = 60_000;
const TASK = "task_0000000001abcdef";

afterAll(removeTempProjects);

const move = (from: string, to: string, ref = "refs/heads/main"): RefMove => ({
  ref,
  from,
  to,
  at: "2026-10-08T00:00:00.000Z",
  taskId: TASK,
});

/** A hook that appends its name to `marker` when git runs it. */
function plantHook(project: TempProject, name: string, marker: string): void {
  const path = join(project.root, ".git", "hooks", name);
  mkdirSync(join(project.root, ".git", "hooks"), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${name} >> "${marker}"\n`);
  chmodSync(path, 0o755);
}

describe("Groot's own ref moves", () => {
  test("a journaled chain of fast-forwards accounts for a move; anything else does not", () => {
    // Arrange
    const moves = [move("a", "b"), move("b", "c"), move("x", "y", "refs/heads/release")];

    // Act / Assert
    expect(movedByGroot(moves, "refs/heads/main", "a", "b")).toBe(true);
    expect(movedByGroot(moves, "refs/heads/main", "a", "c")).toBe(true);
    expect(movedByGroot(moves, "refs/heads/main", "c", "a")).toBe(false);
    expect(movedByGroot(moves, "refs/heads/main", "a", "y")).toBe(false);
    expect(movedByGroot(moves, "refs/heads/release", "a", "b")).toBe(false);
    expect(movedByGroot(moves, "refs/heads/main", undefined, "b")).toBe(false);
    expect(movedByGroot(moves, "refs/heads/main", "a", undefined)).toBe(false);
  });

  test(
    "the journal round-trips and skips unreadable lines",
    async () => {
      // Arrange
      const project = await tempProject();
      recordRefMove(project.root, { ref: "refs/heads/main", from: "a", to: "b", taskId: TASK });
      writeFileSync(join(project.root, ".groot", "ref-moves.jsonl"), "{ torn\n", { flag: "a" });

      // Act
      const moves = await readRefMoves(project.root);

      // Assert
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ ref: "refs/heads/main", from: "a", to: "b", taskId: TASK });
    },
    TIMEOUT,
  );
});

describe("the repository guard", () => {
  test(
    "reports moved refs and added or changed hooks and config",
    async () => {
      // Arrange
      const project = await tempProject();
      await project.git("branch", "release");
      const before = await guardSnapshot(project.root, project.root, project.env);
      project.write("README.md", "# demo\n");
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "second");
      await project.git("update-ref", "refs/heads/release", "HEAD");
      plantHook(project, "post-checkout", "/dev/null");
      await project.git("config", "core.fsmonitor", "/tmp/evil");

      // Act
      const after = await guardSnapshot(project.root, project.root, project.env);
      const changes = await guardChanges(project.root, TASK, before, after);

      // Assert
      const text = changes.join("\n");
      expect(text).toContain("refs/heads/release");
      expect(text).toContain("refs/heads/main");
      expect(text).toContain(".git/hooks/post-checkout added");
      expect(text).toContain(".git/config changed");
    },
    TIMEOUT,
  );

  test(
    "lets other tasks' Groot branches, remote-tracking refs, and journaled moves pass — never the task's own branch",
    async () => {
      // Arrange
      const project = await tempProject();
      const main = (await project.git("rev-parse", "HEAD")).trim();
      const before = await guardSnapshot(project.root, project.root, project.env);
      project.write("README.md", "# demo\n");
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "integrated by groot");
      const next = (await project.git("rev-parse", "HEAD")).trim();
      recordRefMove(project.root, { ref: "refs/heads/main", from: main, to: next, taskId: TASK });
      await project.git("update-ref", "refs/heads/groot/task/task_0000000002abcdef", next);
      await project.git("update-ref", "refs/remotes/origin/main", next);
      await project.git("update-ref", `refs/heads/groot/task/${TASK}`, next);

      // Act
      const after = await guardSnapshot(project.root, project.root, project.env);
      const changes = await guardChanges(project.root, TASK, before, after);

      // Assert
      expect(changes).toEqual([`refs/heads/groot/task/${TASK} (none) → ${next.slice(0, 12)}`]);
    },
    TIMEOUT,
  );

  test(
    "an executable bit set on an existing hook file is a change",
    async () => {
      // Arrange
      const project = await tempProject();
      const hook = join(await gitCommonDir(project.root, project.env), "hooks", "pre-push");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      chmodSync(hook, 0o644);
      const before = await guardSnapshot(project.root, project.root, project.env);
      chmodSync(hook, 0o755);

      // Act
      const after = await guardSnapshot(project.root, project.root, project.env);

      // Assert
      expect(await guardChanges(project.root, TASK, before, after)).toEqual([
        ".git/hooks/pre-push changed",
      ]);
    },
    TIMEOUT,
  );
});

describe("Groot's own git", () => {
  test(
    "never runs repository hooks (worktree checkout, commits, ref updates)",
    async () => {
      // Arrange — hooks that record themselves; plain git runs them (control).
      const project = await tempProject();
      const marker = join(project.root, ".git", "hooks-ran.log");
      for (const name of ["post-checkout", "post-commit", "reference-transaction"]) {
        plantHook(project, name, marker);
      }
      await project.git("worktree", "add", "-q", join(project.root, ".groot", "control"));
      const control = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      writeFileSync(marker, "");

      // Act — Groot creates a task worktree and commits in it.
      const path = await ensureWorktree(
        project.root,
        join(project.root, ".groot", "worktrees", TASK),
        `groot/task/${TASK}`,
        "HEAD",
        project.env,
      );
      writeFileSync(join(path, "src", "extra.ts"), "export const x = 1;\n");
      const commit = await commitAll(path, "groot: test", project.env);

      // Assert
      expect(control).toContain("post-checkout");
      expect(commit.committed).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "commits never stage new files under node_modules, but do stage tracked changes",
    async () => {
      // Arrange — a root-only ignore pattern leaves a workspace package's node_modules unignored.
      const project = await tempProject();
      project.write(".gitignore", "/node_modules/\n");
      project.write("packages/app/package.json", '{ "name": "app" }\n');
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "workspace");
      project.write("packages/app/node_modules/@demo/lib/index.ts", "export {};\n");
      project.write("node_modules/dep/index.js", "module.exports = {};\n");
      project.write("packages/app/package.json", '{ "name": "app", "private": true }\n');
      project.write("src/new.ts", "export const y = 2;\n");

      // Act
      const commit = await commitAll(project.root, "groot: test", project.env);

      // Assert
      expect(commit.committed).toBe(true);
      const files = (await project.git("show", "--name-only", "--format=", "HEAD")).trim();
      expect(files.split("\n").sort()).toEqual(["packages/app/package.json", "src/new.ts"]);
      expect(await project.git("status", "--porcelain")).toContain("?? packages/app/node_modules/");
    },
    TIMEOUT,
  );
});

describe("dependency plan", () => {
  test(
    "directory-only node_modules patterns count as ignored before node_modules exists",
    async () => {
      // Arrange
      const plans: Record<string, boolean> = {};
      for (const pattern of ["node_modules", "node_modules/", "/node_modules/", "/node_modules"]) {
        const project = await tempProject();
        project.write(".gitignore", `${pattern}\n`);
        project.write("bun.lock", "{}\n");

        // Act
        plans[pattern] = (await dependencyPlan(project.root, project.env)).install;
      }
      const unignored = await tempProject();
      unignored.write(".gitignore", "dist\n");
      unignored.write("bun.lock", "{}\n");
      const skipped = await dependencyPlan(unignored.root, unignored.env);

      // Assert
      expect(plans).toEqual({
        node_modules: true,
        "node_modules/": true,
        "/node_modules/": true,
        "/node_modules": true,
      });
      expect(skipped.install).toBe(false);
      expect(skipped.limitations.join(" ")).toContain("not git-ignored");
    },
    TIMEOUT,
  );
});
