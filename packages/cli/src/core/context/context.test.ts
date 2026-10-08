/**
 * Context synchronization and task context: human text outside managed
 * regions survives, re-syncing is a no-op, hand edits become conflicts (never
 * overwrites), nested AGENTS.md files get CLAUDE.md shims, Codex's chain
 * budget is enforced, skills are owned files, and task context carries
 * variable names but never values.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evidenceFixture } from "../../cli/test-support.ts";
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import { schemaUrl } from "../contracts/common.ts";
import { TaskContext } from "../contracts/context.ts";
import type { GrootLock } from "../contracts/lock.ts";
import { OperationPlan } from "../contracts/plan.ts";
import type { AgentFile, ProjectObservation } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { sha256Of } from "../fs/hash.ts";
import { PlanBuilder } from "../planner/builder.ts";
import {
  appFixture,
  blueprintFixture,
  fixtureFact,
  observationFixture,
  unitFixture,
} from "../test-fixtures.ts";
import { findRegions } from "../transforms/regions.ts";
import { renderAgentsRegion } from "./agents.ts";
import { renderSkill, SKILL_PATHS } from "./skill.ts";
import { planContextSync } from "./sync.ts";
import { buildTaskContext } from "./task-context.ts";

const SECRET_VALUE = "super-secret-value-that-must-never-leak-0123456789";

function emptyLock(context: GrootLock["context"] = []): GrootLock {
  return {
    $schema: schemaUrl("lock"),
    lockVersion: 1,
    generatedBy: "create-groot@2.0.0",
    generators: [],
    recipes: [],
    context,
  };
}

function project(files: Record<string, string> = {}, lock: GrootLock = emptyLock()): string {
  const root = mkdtempSync(join(tmpdir(), "groot-context-"));
  const all: Record<string, string> = {
    "groot.lock.json": `${JSON.stringify(lock, null, 2)}\n`,
    "apps/api/.env.local": `BETTER_AUTH_SECRET=${SECRET_VALUE}\n`,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function blueprint(): BlueprintV2 {
  return blueprintFixture({
    project: { name: "acme", topology: "monorepo", packageManager: "bun", origin: "adopted" },
    apps: [
      appFixture({ id: "api", path: "apps/api", port: 3001 }),
      appFixture({
        id: "web",
        path: "apps/web",
        kind: "web",
        framework: "next",
        port: 3000,
        entry: null,
      }),
    ],
    capabilities: [
      {
        id: "auth",
        recipe: "auth.better-auth",
        recipeVersion: "1.0.0",
        target: "api",
        options: {},
        addedBy: null,
        addedAt: "2026-10-07T00:00:00.000Z",
      },
    ],
    environment: [
      {
        name: "BETTER_AUTH_SECRET",
        consumer: "apps/api",
        scope: "server",
        sensitivity: "secret",
        required: true,
        description: "signs session cookies",
        storage: "apps/api/.env.local",
        example: "",
        generate: "random-secret",
        declaredBy: "auth.better-auth",
      },
      {
        name: "DATABASE_URL",
        consumer: "apps/api",
        scope: "server",
        sensitivity: "config",
        required: true,
        description: "SQLite file path",
        storage: "apps/api/.env.local",
        example: "./data/app.db",
        generate: "none",
        declaredBy: "data.drizzle-sqlite",
      },
    ],
    verification: [
      {
        id: "auth.flow",
        profile: "product-flow",
        description: "sign-up, protected write, unauthorized rejection",
        checker: "auth.flow",
        capability: "auth",
        unit: "apps/api",
        needs: { network: false, processes: true, credentials: [], toolchains: [] },
      },
    ],
  });
}

function agentFile(
  path: string,
  content: string,
  tool: AgentFile["tool"] = "agents-md",
): AgentFile {
  return {
    path,
    tool,
    bytes: Buffer.byteLength(content),
    sha256: sha256Of(content),
    managedRegions: [],
  };
}

function observation(root: string, agentFiles: AgentFile[] = []): ProjectObservation {
  return {
    ...observationFixture(
      [
        unitFixture({
          path: "apps/api",
          scripts: { dev: "bun run --hot src/index.ts", typecheck: "tsc --noEmit" },
        }),
        unitFixture({
          path: "apps/web",
          kind: fixtureFact("web" as const),
          scripts: { dev: "next dev", build: "next build" },
        }),
      ],
      root,
    ),
    agentFiles,
  };
}

function builder(root: string): PlanBuilder {
  return new PlanBuilder({
    root,
    intent: { type: "context-sync" },
    summary: "sync managed agent instructions",
    topology: "monorepo",
    revision: { vcs: "none", head: null, branch: null, dirty: false, worktreeFingerprint: null },
    createdWith: "create-groot@2.0.0",
  });
}

/** Materialize a plan's file results on disk (test stand-in for the executor). */
function materialize(root: string, plan: OperationPlan): void {
  for (const action of plan.actions) {
    if (action.type === "file.write") {
      mkdirSync(dirname(join(root, action.path)), { recursive: true });
      writeFileSync(join(root, action.path), action.content);
    } else if (action.type === "file.edit" && action.after !== null) {
      writeFileSync(join(root, action.path), action.after.content);
    }
  }
}

describe("context sync", () => {
  test("a fresh project gets AGENTS.md, a CLAUDE.md import, both skill projections, and lock ownership", async () => {
    const root = project();
    const plan = builder(root);
    const result = await planContextSync({
      builder: plan,
      blueprint: blueprint(),
      observation: observation(root),
      lock: emptyLock(),
      skipConflicts: false,
    });
    const built = OperationPlan.parse(plan.build());
    const paths = built.actions.map((action) => ("path" in action ? action.path : ""));
    expect(paths).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      SKILL_PATHS.claude,
      SKILL_PATHS.agents,
      "groot.lock.json",
    ]);
    expect(result.changes.filter((change) => change.action === "create")).toHaveLength(4);
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
      ".agents/skills/groot/SKILL.md",
      ".claude/skills/groot/SKILL.md",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    const claude = built.actions.find(
      (action) => action.type === "file.write" && action.path === "CLAUDE.md",
    );
    expect(claude?.type === "file.write" && claude.content.includes("@AGENTS.md")).toBe(true);
    const skills = built.actions.filter(
      (action) => action.type === "file.write" && action.path.endsWith("SKILL.md"),
    );
    expect(
      new Set(skills.map((action) => (action.type === "file.write" ? action.content : ""))).size,
    ).toBe(1);
  });

  test("human text survives, and re-syncing a synced project is a no-op", async () => {
    const human = "# Acme\n\nAlways run the smoke test before pushing.\n";
    const humanClaude = "Prefer small commits.\n";
    const root = project({ "AGENTS.md": human, "CLAUDE.md": humanClaude });
    const first = builder(root);
    const firstResult = await planContextSync({
      builder: first,
      blueprint: blueprint(),
      observation: observation(root),
      lock: emptyLock(),
      skipConflicts: false,
    });
    const firstPlan = first.build();
    materialize(root, firstPlan);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith(human)).toBe(true);
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude.split("\n")[1]).toBe("@AGENTS.md");
    expect(claude).toContain(humanClaude.trim());

    const lock = JSON.parse(readFileSync(join(root, "groot.lock.json"), "utf8")) as GrootLock;
    expect(lock.context).toEqual(firstResult.artifacts);
    const second = builder(root);
    const secondResult = await planContextSync({
      builder: second,
      blueprint: blueprint(),
      observation: observation(root),
      lock,
      skipConflicts: false,
    });
    expect(second.build().actions).toHaveLength(0);
    expect(secondResult.changes.every((change) => change.action === "unchanged")).toBe(true);
  });

  test("a hand-edited managed region is a conflict; --skip-conflicts syncs the rest", async () => {
    const root = project();
    const first = builder(root);
    await planContextSync({
      builder: first,
      blueprint: blueprint(),
      observation: observation(root),
      lock: emptyLock(),
      skipConflicts: false,
    });
    materialize(root, first.build());
    const lock = JSON.parse(readFileSync(join(root, "groot.lock.json"), "utf8")) as GrootLock;
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(
      agentsPath,
      readFileSync(agentsPath, "utf8").replace("Topology:", "Topology (edited):"),
    );

    const strict = builder(root);
    let error: unknown;
    try {
      await planContextSync({
        builder: strict,
        blueprint: blueprint(),
        observation: observation(root),
        lock,
        skipConflicts: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof GrootV2Error && error.id === "GROOT_E_CONFLICT").toBe(true);

    const lenient = builder(root);
    const result = await planContextSync({
      builder: lenient,
      blueprint: blueprint(),
      observation: observation(root),
      lock,
      skipConflicts: true,
    });
    expect(result.conflicts.map((change) => change.path)).toEqual(["AGENTS.md"]);
    expect(
      lenient.build().actions.some((action) => "path" in action && action.path === "AGENTS.md"),
    ).toBe(false);
  });

  test("skills: an unowned existing file conflicts; an owned unchanged one is updated", async () => {
    const stale = "---\nname: groot\ndescription: old\n---\nold body\n";
    const root = project({
      [SKILL_PATHS.agents]: stale,
      [SKILL_PATHS.claude]: "my own claude skill\n",
    });
    const lock = emptyLock([
      { path: SKILL_PATHS.agents, ownership: "file", parts: [], sha256: sha256Of(stale) },
    ]);
    const plan = builder(root);
    const result = await planContextSync({
      builder: plan,
      blueprint: blueprint(),
      observation: observation(root),
      lock,
      skipConflicts: true,
    });
    expect(result.conflicts.map((change) => change.path)).toEqual([SKILL_PATHS.claude]);
    const update = plan
      .build()
      .actions.find((action) => action.type === "file.write" && action.path === SKILL_PATHS.agents);
    expect(update?.type === "file.write" && update.content === renderSkill()).toBe(true);
    expect(update?.type === "file.write" && update.expect).toEqual({
      state: "sha256",
      sha256: sha256Of(stale),
    });
  });

  test("nested AGENTS.md files get sibling CLAUDE.md shims; .claude/CLAUDE.md is honored", async () => {
    const nested = "# web\n\nUse the app router.\n";
    const root = project({
      "apps/web/AGENTS.md": nested,
      ".claude/CLAUDE.md": "Project rules for Claude.\n",
    });
    const plan = builder(root);
    await planContextSync({
      builder: plan,
      blueprint: blueprint(),
      observation: observation(root, [
        agentFile("apps/web/AGENTS.md", nested),
        agentFile(".claude/CLAUDE.md", "Project rules for Claude.\n", "claude-md"),
      ]),
      lock: emptyLock(),
      skipConflicts: false,
    });
    const built = plan.build();
    const shim = built.actions.find(
      (action) => "path" in action && action.path === "apps/web/CLAUDE.md",
    );
    expect(shim?.type === "file.write" && shim.content.includes("@AGENTS.md")).toBe(true);
    const dotClaude = built.actions.find(
      (action) => "path" in action && action.path === ".claude/CLAUDE.md",
    );
    expect(
      dotClaude?.type === "file.edit" && dotClaude.after?.content.includes("@../AGENTS.md"),
    ).toBe(true);
    expect(built.actions.some((action) => "path" in action && action.path === "CLAUDE.md")).toBe(
      false,
    );
  });

  test("refuses to push the root→nested chain past Codex's 32 KiB budget", async () => {
    const nested = `# web\n\n${"x".repeat(31_500)}\n`;
    const root = project({ "apps/web/AGENTS.md": nested });
    let error: unknown;
    try {
      await planContextSync({
        builder: builder(root),
        blueprint: blueprint(),
        observation: observation(root, [agentFile("apps/web/AGENTS.md", nested)]),
        lock: emptyLock(),
        skipConflicts: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof GrootV2Error && error.id === "GROOT_E_BLOCKED").toBe(true);
  });

  test("the chain budget holds without CLAUDE.md and counts every AGENTS.md on the way down", async () => {
    const sync = async (files: Record<string, string>, claudeMd: string | null) => {
      const root = project(files);
      const doc = blueprint();
      try {
        await planContextSync({
          builder: builder(root),
          blueprint: { ...doc, context: { ...doc.context, claudeMd } },
          observation: observation(
            root,
            Object.entries(files).map(([path, content]) => agentFile(path, content)),
          ),
          lock: emptyLock(),
          skipConflicts: false,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    };
    const blocked = (error: unknown) =>
      error instanceof GrootV2Error && error.id === "GROOT_E_BLOCKED";

    // Opting out of CLAUDE.md doesn't opt out of Codex's budget.
    const big = `# web\n\n${"x".repeat(31_500)}\n`;
    expect(blocked(await sync({ "apps/web/AGENTS.md": big }, null))).toBe(true);

    // Codex concatenates root → apps → apps/web: ~34 KB although each pair fits.
    const half = (name: string) => `# ${name}\n\n${"y".repeat(16_000)}\n`;
    const chain = { "apps/AGENTS.md": half("apps"), "apps/web/AGENTS.md": half("web") };
    const refused = await sync(chain, "CLAUDE.md");
    expect(blocked(refused)).toBe(true);
    expect((refused as GrootV2Error).message).toContain("apps/AGENTS.md + apps/web/AGENTS.md");

    // Siblings are separate chains: 16 KB + 16 KB under different directories fits.
    const siblings = { "apps/api/AGENTS.md": half("api"), "apps/web/AGENTS.md": half("web") };
    expect(await sync(siblings, "CLAUDE.md")).toBeNull();
  });

  test("the managed region lists variable names and storage, never values", () => {
    const region = renderAgentsRegion(blueprint(), observation("/tmp/x"));
    expect(region).toContain("`BETTER_AUTH_SECRET`");
    expect(region).toContain("`apps/api/.env.local`");
    expect(region).not.toContain(SECRET_VALUE);
    expect(region).toContain("bun run --cwd apps/api dev");
    expect(findRegions(`<!-- groot:begin x -->\n${region}\n<!-- groot:end x -->`)).toHaveLength(1);
  });
});

describe("task context", () => {
  test("ranks the relevant app, keeps names not values, and lists acceptance and gaps", () => {
    const root = project({ "apps/api/.env.local": "DATABASE_URL=./data/app.db\n" });
    const context = buildTaskContext({
      blueprint: blueprint(),
      observation: observation(root),
      evidence: [],
      task: "Add a protected API endpoint for user account settings",
      root,
    });
    expect(TaskContext.safeParse(context).success).toBe(true);
    expect(context.units[0]?.id).toBe("api");
    expect(context.units[0]?.relevance).toBeGreaterThan(0.5);
    expect(context.environment.map((entry) => entry.name)).toEqual([
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
    ]);
    expect(context.acceptance.map((entry) => entry.id)).toEqual(["auth.flow"]);
    expect(context.gaps).toContain("BETTER_AUTH_SECRET is not set in apps/api/.env.local");
    expect(JSON.stringify(context)).not.toContain(SECRET_VALUE);
  });

  test("a cancelled check's record never hides the last real result for that check", () => {
    const root = project();
    const scope = { capability: "auth", unit: "apps/api", operationId: null, taskId: null };
    const failed = evidenceFixture("auth.flow", "fail", {
      profile: "product-flow",
      scope,
      reason: "sign-up returned 500",
    });
    const cancelled = evidenceFixture("auth.flow", "skipped", {
      profile: "product-flow",
      scope,
      summary: "not run — verification was cancelled",
      reason: "cancelled",
    });

    const context = buildTaskContext({
      blueprint: blueprint(),
      observation: observation(root),
      evidence: [cancelled, failed], // newest first, as listEvidence returns them
      task: "fix sign up on the api",
      root,
    });

    expect(context.evidence.map((entry) => [entry.id, entry.status])).toEqual([
      [failed.id, "fail"],
    ]);
    expect(context.gaps).toContain("auth.flow is fail: sign-up returned 500");
  });

  test("without a task every app is in scope; unregistered projects say so", () => {
    const root = project();
    const whole = buildTaskContext({
      blueprint: blueprint(),
      observation: observation(root),
      evidence: [],
      task: null,
      root,
    });
    expect(whole.units.map((unit) => unit.relevance)).toEqual([1, 1]);
    const unregistered = buildTaskContext({
      blueprint: null,
      observation: observation(root),
      evidence: [],
      task: "fix the web page",
      root,
    });
    expect(unregistered.project.registered).toBe(false);
    expect(unregistered.gaps.some((gap) => gap.includes("not registered"))).toBe(true);
    expect(unregistered.units[0]?.path).toBe("apps/web");
  });
});
