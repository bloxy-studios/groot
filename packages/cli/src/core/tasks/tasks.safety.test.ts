/**
 * Task containment with a SIMULATED runner in real git repositories:
 * pre-review acceptance runs the agent's code without credentials (and its
 * evidence says what was not restricted), env-derived secrets never reach
 * evidence, acceptance tails, retry prompts, or emitted events, dependencies
 * are installed into the worktree so checks resolve the worktree's own
 * workspace packages (whatever form the node_modules ignore pattern takes),
 * an attempt that moves git refs outside its task branch is blocked before
 * any check runs, and the agent's code moving refs or planting a hook during
 * the checks blocks the task and stops the remaining checks.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../contracts/task.ts";
import { appFixture, blueprintFixture } from "../test-fixtures.ts";
import { readEvidence } from "../verify/store.ts";
import { createTask, runTask } from "./index.ts";
import { latestAcceptance, taskPaths } from "./store.ts";
import {
  FIXED_MATH,
  removeTempProjects,
  type TempProject,
  tempProject,
} from "./testing/temp-project.ts";

const TIMEOUT = 180_000;
const GRACE = { interruptMs: 2000, terminateMs: 2000 };
const TOKEN = "tok-abcdef1234567890";

afterAll(removeTempProjects);

/** An agent-written test that records what its environment holds. */
const ENV_PROBE_TEST = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";

test("records the environment", () => {
  const env = process.env;
  writeFileSync(
    "env-seen.json",
    JSON.stringify({ token: env.MY_SERVICE_API_TOKEN ?? null, home: env.HOME ?? null, ci: env.CI ?? null }),
  );
});
`;

/** A failing check whose output carries a value equal to a credential in Groot's environment. */
const LEAK_TEST = `import { expect, test } from "bun:test";

test("prints a credential", () => {
  console.log("value: ${TOKEN}");
  expect(1).toBe(2);
});
`;

/** An agent-written test that moves another branch and plants a hook in the shared git directory. */
const ESCAPE_TEST = `import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("looks harmless", () => {
  spawnSync("git", ["update-ref", "refs/heads/release", "HEAD"]);
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    .stdout.toString()
    .trim();
  mkdirSync(join(common, "hooks"), { recursive: true });
  writeFileSync(join(common, "hooks", "post-checkout"), "#!/bin/sh\\nexit 0\\n");
  chmodSync(join(common, "hooks", "post-checkout"), 0o755);
});
`;

async function evidenceOf(project: TempProject, task: Task, check: string) {
  for (const id of task.evidence) {
    const evidence = await readEvidence(project.root, id);
    if (evidence.check === check) return evidence;
  }
  throw new Error(`no ${check} evidence on ${task.id}`);
}

/** Every file below `dir` (recursive), as text. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

async function bun(project: TempProject, ...args: string[]): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: project.root,
    env: project.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`bun ${args.join(" ")} failed: ${stderr}`);
}

describe("pre-review acceptance", () => {
  test(
    "runs the agent's code without credentials, and its evidence states the limits",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: { "src/math.ts": FIXED_MATH, "src/env.test.ts": ENV_PROBE_TEST },
          },
        ],
      });
      const ctx = project.context(undefined, { MY_SERVICE_API_TOKEN: TOKEN });
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("awaiting-review");
      const seen = JSON.parse(
        readFileSync(join(ran.worktree?.path ?? "", "env-seen.json"), "utf8"),
      );
      expect(seen).toEqual({ token: null, home: project.env.HOME ?? null, ci: "1" });
      const evidence = await evidenceOf(project, ran, "task.accept-1");
      expect(evidence.status).toBe("pass");
      const limits = evidence.limitations.join(" ");
      expect(limits).toContain("before review");
      expect(limits).toContain("credential");
      expect(limits).toContain("read and write any file");
    },
    TIMEOUT,
  );

  test(
    "the agent's code moving a ref or planting a hook blocks the task and stops the remaining checks",
    async () => {
      // Arrange — `release` sits on the first commit; the task starts from the second.
      const project = await tempProject();
      await project.git("branch", "release");
      project.write("README.md", "# demo\n");
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "second");
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: { "src/math.ts": FIXED_MATH, "src/escape.test.ts": ESCAPE_TEST },
          },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test", "bun test src/math.test.ts"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("blocked");
      expect(ran.statusReason).toContain("acceptance checks");
      expect(ran.statusReason).toContain("refs/heads/release");
      expect(ran.statusReason).toContain(".git/hooks/post-checkout added");
      const records = (await latestAcceptance(project.root, ran)) ?? [];
      expect(records.map((record) => record.status)).toEqual(["pass", "skipped"]);
      expect(records[1]?.summary).toContain("repository changed");
      expect(project.fakes.records()).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "env-derived secrets never reach evidence, acceptance tails, or retry prompts",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/leak.test.ts": LEAK_TEST } }],
      });
      const ctx = project.context(undefined, { MY_SERVICE_API_TOKEN: TOKEN });
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
        limits: { maxAttempts: 2 },
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("failed");
      const evidenceFiles = filesUnder(join(project.root, ".groot", "evidence"));
      expect(evidenceFiles.join("\n")).toContain("[REDACTED]");
      const stored = [
        ...evidenceFiles,
        ...filesUnder(taskPaths.dir(project.root, task.id)),
        ...ctx.log.map((event) => event.message),
      ];
      for (const text of stored) expect(text).not.toContain(TOKEN);
      expect(readFileSync(taskPaths.prompt(project.root, task.id), "utf8")).toContain(
        "did not all pass",
      );
    },
    TIMEOUT,
  );

  test(
    "verification evidence imported from the worktree is redacted too, and not left behind",
    async () => {
      // Arrange — a registered project whose build prints the credential's value.
      const project = await tempProject();
      project.write(
        "package.json",
        JSON.stringify({ name: "demo", private: true, scripts: { build: `echo ${TOKEN}` } }),
      );
      project.write(
        "groot.json",
        JSON.stringify(blueprintFixture({ apps: [appFixture({ id: "demo", path: "." })] })),
      );
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "register");
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context(undefined, { MY_SERVICE_API_TOKEN: TOKEN });
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        acceptVerify: ["build"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("awaiting-review");
      const evidenceFiles = filesUnder(join(project.root, ".groot", "evidence"));
      expect(evidenceFiles.join("\n")).toContain("[REDACTED]");
      for (const text of evidenceFiles) expect(text).not.toContain(TOKEN);
      expect(filesUnder(join(ran.worktree?.path ?? "", ".groot", "evidence"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "verification events are redacted too; build evidence states its scripts ran credential-free",
    async () => {
      // Arrange — a registered project whose build fails printing the credential's value.
      const project = await tempProject();
      project.write(
        "package.json",
        JSON.stringify({
          name: "demo",
          private: true,
          scripts: { build: `echo build output: ${TOKEN}; exit 1` },
        }),
      );
      project.write(
        "groot.json",
        JSON.stringify(blueprintFixture({ apps: [appFixture({ id: "demo", path: "." })] })),
      );
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "register");
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "src/math.ts": FIXED_MATH } }],
      });
      const ctx = project.context(undefined, { MY_SERVICE_API_TOKEN: TOKEN });
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        acceptVerify: ["build"],
        limits: { maxAttempts: 1 },
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("failed");
      const finished = ctx.log.filter((event) => event.type === "check.finished");
      expect(finished.map((event) => event.message).join("\n")).toContain("[REDACTED]");
      for (const event of ctx.log) expect(JSON.stringify(event)).not.toContain(TOKEN);
      const build = (await Promise.all(ran.evidence.map((id) => readEvidence(project.root, id))))
        .filter((evidence) => evidence.method.tool === "build.build")
        .flatMap((evidence) => evidence.limitations);
      expect(build.join(" ")).toContain("credential-like environment variables removed");
      expect(build.join(" ")).not.toContain("full environment");
    },
    TIMEOUT,
  );
});

describe("dependencies in task worktrees", () => {
  /**
   * A bun workspace: @demo/app tests @demo/lib; installed (bun.lock committed)
   * in the main checkout — whose own unignored node_modules stay uncommitted.
   */
  async function workspaceProject(gitignore = "node_modules\n"): Promise<TempProject> {
    const project = await tempProject();
    project.write(".gitignore", gitignore);
    project.write(
      "package.json",
      JSON.stringify({ name: "demo", private: true, type: "module", workspaces: ["packages/*"] }),
    );
    project.write(
      "packages/lib/package.json",
      JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.ts" }),
    );
    project.write("packages/lib/index.ts", 'export const where = "main checkout";\n');
    project.write(
      "packages/app/package.json",
      JSON.stringify({
        name: "@demo/app",
        version: "1.0.0",
        type: "module",
        dependencies: { "@demo/lib": "workspace:*" },
      }),
    );
    project.write(
      "packages/app/where.test.ts",
      'import { expect, test } from "bun:test";\nimport { where } from "@demo/lib";\n\ntest("resolves the changed lib", () => {\n  expect(where).toBe("worktree");\n});\n',
    );
    await bun(project, "install");
    await project.git("add", "-A", "--", ".", ":(exclude,glob)**/node_modules/**");
    await project.git("commit", "-q", "-m", "workspace");
    return project;
  }

  for (const gitignore of ["node_modules/", "/node_modules/"]) {
    test(
      `a directory-only ignore pattern (${gitignore}) still gets the install; nested node_modules are never committed`,
      async () => {
        // Arrange — attempt 1 misses (its install leaves a workspace package's node_modules
        // behind), attempt 2 fixes it and is committed over that leftover.
        const project = await workspaceProject(`${gitignore}\n`);
        project.fakes.scenario({
          steps: [
            {
              mode: "success",
              edits: { "packages/lib/index.ts": 'export const where = "elsewhere";\n' },
            },
            {
              mode: "success",
              edits: { "packages/lib/index.ts": 'export const where = "worktree";\n' },
            },
          ],
        });
        const ctx = project.context();
        const task = await createTask(ctx, project.root, {
          objective: "move lib",
          accept: ["bun test where"],
          limits: { maxAttempts: 2 },
        });

        // Act
        const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

        // Assert
        expect(ran.status).toBe("awaiting-review");
        expect(ran.attempts).toHaveLength(2);
        const install = await evidenceOf(project, ran, "task.dependencies");
        expect(install.status).toBe("pass");
        const tracked = await project.git("ls-tree", "-r", "--name-only", `groot/task/${task.id}`);
        expect(tracked).not.toContain("node_modules");
      },
      TIMEOUT,
    );
  }

  test(
    "checks resolve the worktree's own workspace packages, never the main checkout's",
    async () => {
      // Arrange — the agent changes @demo/lib inside the task worktree.
      const project = await workspaceProject();
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: { "packages/lib/index.ts": 'export const where = "worktree";\n' },
          },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "move lib",
        accept: ["bun test where"],
        limits: { maxAttempts: 1 },
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert — `where.test.ts` passes only when @demo/lib is the worktree's copy.
      expect(ran.status).toBe("awaiting-review");
      const install = await evidenceOf(project, ran, "task.dependencies");
      expect(install).toMatchObject({ status: "pass" });
      expect(install.method.command?.argv).toEqual(["bun", "install", "--frozen-lockfile"]);
      expect(existsSync(join(ran.worktree?.path ?? "", "node_modules"))).toBe(true);
      expect(await project.git("status", "--porcelain")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "a failed install blocks the task with the install evidence",
    async () => {
      // Arrange — the agent breaks the lockfile.
      const project = await workspaceProject();
      project.fakes.scenario({
        steps: [{ mode: "success", edits: { "bun.lock": "{ this is not a lockfile" } }],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "break it",
        accept: ["bun test where"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("blocked");
      expect(ran.statusReason).toContain("dependencies");
      const install = await evidenceOf(project, ran, "task.dependencies");
      expect(install.status).toBe("blocked");
      expect(project.fakes.records()).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe("git refs outside the task branch", () => {
  test(
    "an attempt that moves another branch is blocked before any check runs",
    async () => {
      // Arrange — `release` sits on the first commit; the task starts from the second.
      const project = await tempProject();
      await project.git("branch", "release");
      project.write("README.md", "# demo\n");
      await project.git("add", "-A");
      await project.git("commit", "-q", "-m", "second");
      const release = (await project.git("rev-parse", "release")).trim();
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: { "src/math.ts": FIXED_MATH },
            moveRef: { ref: "refs/heads/release", to: "HEAD" },
          },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("blocked");
      expect(ran.statusReason).toContain("refs/heads/release");
      expect(ran.statusReason).toContain(release.slice(0, 12));
      expect(ran.evidence).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "Groot's own branches and remote-tracking refs may move (parallel tasks, background fetches)",
    async () => {
      // Arrange
      const project = await tempProject();
      project.fakes.scenario({
        steps: [
          {
            mode: "success",
            edits: { "src/math.ts": FIXED_MATH },
            moveRef: { ref: "refs/remotes/origin/main", to: "HEAD" },
          },
        ],
      });
      const ctx = project.context();
      const task = await createTask(ctx, project.root, {
        objective: "fix add",
        accept: ["bun test"],
      });

      // Act
      const ran = await runTask(ctx, project.root, task.id, { grace: GRACE });

      // Assert
      expect(ran.status).toBe("awaiting-review");
    },
    TIMEOUT,
  );
});
