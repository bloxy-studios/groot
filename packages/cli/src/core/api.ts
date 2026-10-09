/**
 * The shared core API — one implementation behind every surface. CLI
 * commands and the MCP server call these functions, so discovery, planning,
 * policy enforcement, execution, verification, context, and tasks behave
 * identically no matter who asks.
 */
import { posix } from "node:path";
import { readLock, readManifest } from "./blueprint/index.ts";
import { bootstrapCore } from "./bootstrap.ts";
import { listCapabilities } from "./capabilities/registry.ts";
import { planContextSync } from "./context/sync.ts";
import { buildTaskContext } from "./context/task-context.ts";
import type { BlueprintV2, Policy } from "./contracts/blueprint.ts";
import type { Sha256, VerificationProfile } from "./contracts/common.ts";
import { schemaUrl } from "./contracts/common.ts";
import { ERROR_IDS } from "./contracts/envelope.ts";
import type { VerificationReport } from "./contracts/evidence.ts";
import { CONTRACTS } from "./contracts/index.ts";
import type { GrootLock } from "./contracts/lock.ts";
import { OperationPlan } from "./contracts/plan.ts";
import { inspect } from "./discovery/index.ts";
import { exitCodeFor, GrootV2Error } from "./errors.ts";
import {
  applyPlan,
  listOperations,
  loadPlanFile,
  loadProjectPolicy,
  previewRollback,
  readOperation,
  resumeOperation,
  rollbackOperation,
  savePlan,
} from "./executor/index.ts";
import { findProjectRoot } from "./executor/root.ts";
import type { GrootApi } from "./mcp/api.ts";
import { planAddCapability } from "./planner/add-capability.ts";
import { PlanBuilder } from "./planner/builder.ts";
import { type CoreContext, createdWith, GROOT_VERSION } from "./runtime.ts";
import { statePaths } from "./state.ts";
import * as tasks from "./tasks/index.ts";
import { defaultContracts } from "./verify/checkers.ts";
import { runVerification } from "./verify/engine.ts";
import { listEvidence, readEvidence } from "./verify/store.ts";

export interface RegisteredProject {
  readonly blueprint: BlueprintV2;
  readonly blueprintSha: Sha256;
  readonly lock: GrootLock;
}

/** Load a v2-registered project or explain precisely why it isn't one. */
export async function requireRegistered(root: string): Promise<RegisteredProject> {
  const manifest = await readManifest(root);
  if (manifest.state === "absent") {
    throw new GrootV2Error(
      "GROOT_E_NOT_REGISTERED",
      `${root} is not registered with groot (no groot.json).`,
      {
        hint: "Preview registration with `groot adopt --dry-run`, or create a project with `groot init`.",
      },
    );
  }
  if (manifest.state === "v1") {
    throw new GrootV2Error(
      "GROOT_E_MIGRATION_REQUIRED",
      `${root} has a groot.json version 1 manifest.`,
      {
        hint: "Migrate explicitly with `groot migrate --dry-run` (previewable, reversible), then retry.",
      },
    );
  }
  const lock = await readLock(root);
  return {
    blueprint: manifest.doc,
    blueprintSha: manifest.sha256,
    lock:
      lock.state === "present"
        ? lock.doc
        : {
            $schema: schemaUrl("lock"),
            lockVersion: 1,
            generatedBy: createdWith(),
            generators: [],
            recipes: [],
            context: [],
          },
  };
}

/**
 * The project's action policy: DEFAULT_POLICY until registered; an invalid or
 * unreadable groot.json fails closed (executor/project-policy.ts).
 */
export async function projectPolicy(root: string): Promise<Policy> {
  return (await loadProjectPolicy(root)).policy;
}

export interface VerifyOptions {
  readonly profiles: readonly VerificationProfile[];
  readonly capability: string | null;
  /** One app's path (`groot verify --unit`): its checks plus the project-wide ones. */
  readonly unit?: string | null;
}

/** The blueprint app path `unit` names ("./apps/api/" → "apps/api"), or GROOT_E_USAGE. */
function unitPath(blueprint: BlueprintV2, unit: string): string {
  const path = posix.normalize(unit).replace(/\/+$/, "") || ".";
  const app = blueprint.apps.find((entry) => entry.path === path);
  if (app !== undefined) return app.path;
  throw new GrootV2Error("GROOT_E_USAGE", `No app at "${unit}" in groot.json.`, {
    hint: `Apps: ${blueprint.apps.map((entry) => entry.path).join(", ")}.`,
  });
}

/** Run the project's verification contracts (blueprint + defaults) and record evidence. */
export async function verifyProject(
  ctx: CoreContext,
  root: string,
  options: VerifyOptions,
): Promise<VerificationReport> {
  const project = await requireRegistered(root);
  const unit = options.unit == null ? null : unitPath(project.blueprint, options.unit);
  return runVerification(ctx, {
    root,
    blueprint: project.blueprint,
    observation: await inspect(ctx, root),
    lock: project.lock,
    profiles: options.profiles,
    capability: options.capability,
    unit,
    extra: defaultContracts(project.blueprint),
  });
}

export function createApi(): GrootApi {
  bootstrapCore();
  return {
    async describe() {
      return {
        grootVersion: GROOT_VERSION,
        contracts: CONTRACTS.map((entry) => ({
          name: entry.name,
          title: entry.title,
          url: schemaUrl(entry.name),
        })),
        capabilities: listCapabilities().map((capability) => ({
          id: capability.id,
          title: capability.title,
          recipes: capability.recipes,
        })),
        errorIds: ERROR_IDS.map((id) => ({ id, exitCode: exitCodeFor(id) })),
      };
    },

    projectRoot(dir) {
      return findProjectRoot(dir) ?? dir;
    },

    inspect(ctx, root) {
      return inspect(ctx, root);
    },

    async context(ctx, root, task) {
      const manifest = await readManifest(root).catch(() => ({ state: "absent" as const }));
      const observation = await inspect(ctx, root);
      return buildTaskContext({
        blueprint: manifest.state === "v2" ? manifest.doc : null,
        observation,
        evidence: await listEvidence(root),
        task,
        root,
      });
    },

    async planAdd(ctx, root, requests, options) {
      const project = await requireRegistered(root);
      const plan = await planAddCapability(ctx, {
        root,
        blueprint: project.blueprint,
        blueprintSha: project.blueprintSha,
        lock: project.lock,
        observation: await inspect(ctx, root),
        requested: requests,
        allowExperimental: options.experimental,
      });
      await savePlan(root, plan);
      return plan;
    },

    async planContextSync(ctx, root, skipConflicts) {
      const project = await requireRegistered(root);
      const observation = await inspect(ctx, root);
      const builder = new PlanBuilder({
        root,
        intent: { type: "context-sync" },
        summary: "synchronize groot-managed agent instructions and skills",
        topology: project.blueprint.project.topology,
        revision: {
          vcs: observation.git.vcs,
          head: observation.git.head,
          branch: observation.git.branch,
          dirty: observation.git.dirty,
          worktreeFingerprint: observation.git.worktreeFingerprint,
        },
        createdWith: createdWith(),
        dirtyPaths: new Set([
          ...observation.git.staged,
          ...observation.git.unstaged,
          ...observation.git.untracked,
        ]),
      });
      builder.precondition({ type: "manifest", state: "v2", sha256: project.blueprintSha });
      const result = await planContextSync({
        builder,
        blueprint: project.blueprint,
        observation,
        lock: project.lock,
        skipConflicts,
      });
      builder.setRecovery({
        mode: "full",
        summary:
          "Rollback restores each instruction file and skill from backup if unchanged since sync.",
        irreversible: [],
        limits: [],
      });
      const plan = builder.build();
      await savePlan(root, plan);
      return {
        plan,
        changes: result.changes,
        // Every surface reports a skipped conflict: the plan leaves that file alone.
        warnings: [
          ...result.warnings,
          ...result.conflicts.map((change) => `skipped ${change.path}: ${change.reason}`),
        ],
      };
    },

    async getPlan(root, planId) {
      if (!/^plan_[0-9a-z]+$/.test(planId)) {
        throw new GrootV2Error("GROOT_E_USAGE", `"${planId}" is not a plan id.`);
      }
      try {
        return OperationPlan.parse(await loadPlanFile(statePaths.plan(root, planId)));
      } catch (error) {
        if (error instanceof GrootV2Error && error.id !== "GROOT_E_NOT_FOUND") throw error;
        throw new GrootV2Error("GROOT_E_NOT_FOUND", `No saved plan ${planId} in this project.`, {
          hint: "Create one with `groot plan add <capability>` (or plan_add over MCP).",
        });
      }
    },

    async apply(ctx, root, plan, approvals) {
      return applyPlan(ctx, {
        plan,
        root,
        policy: await projectPolicy(root),
        command: "apply",
        approvals,
      });
    },

    resume(ctx, root, operationId, options) {
      return resumeOperation(ctx, root, operationId, options);
    },

    previewRollback(ctx, root, operationId) {
      return previewRollback(ctx, root, operationId);
    },

    rollback(ctx, root, operationId) {
      return rollbackOperation(ctx, root, operationId);
    },

    listOperations(root) {
      return listOperations(root);
    },

    readOperation(root, operationId) {
      return readOperation(root, operationId);
    },

    verify(ctx, root, options) {
      return verifyProject(ctx, root, options);
    },

    getEvidence(root, id) {
      return readEvidence(root, id);
    },

    createTask(ctx, root, request) {
      return tasks.createTask(ctx, root, {
        objective: request.objective,
        title: request.title,
        runner: request.runner,
        model: request.model ?? null,
        dependsOn: [...(request.dependsOn ?? [])],
        ownership: [...(request.ownership ?? [])],
        accept: [...(request.accept ?? [])],
        acceptVerify: [...(request.acceptVerify ?? [])],
      } as Parameters<typeof tasks.createTask>[2]);
    },

    listTasks(root) {
      return tasks.listTasks(root);
    },

    readTask(root, id) {
      return tasks.readTask(root, id);
    },

    runTask(ctx, root, id) {
      return tasks.runTask(ctx, root, id, { contextProvider: taskContextProvider(ctx) });
    },

    reviewTask(ctx, root, id, decision) {
      return tasks.reviewTask(ctx, root, id, decision);
    },

    integrateTask(ctx, root, id) {
      return tasks.integrateTask(ctx, root, id);
    },
  };
}

/**
 * Task prompts get the same task-scoped context `groot context --task` returns,
 * rendered compactly (names and commands — never secret values).
 */
export function taskContextProvider(ctx: Parameters<GrootApi["inspect"]>[0]) {
  return async (root: string, task: { objective: string }): Promise<string> => {
    const manifest = await readManifest(root).catch(() => ({ state: "absent" as const }));
    const context = buildTaskContext({
      blueprint: manifest.state === "v2" ? manifest.doc : null,
      observation: await inspect(ctx, root),
      evidence: await listEvidence(root),
      task: task.objective,
      root,
    });
    const lines = [
      `Project: ${context.project.name} (${context.project.topology})`,
      ...context.units.map(
        (unit) =>
          `- ${unit.path} (${unit.kind}${unit.framework ? `, ${unit.framework}` : ""}${unit.entry ? `, entry ${unit.entry}` : ""}) — ${unit.why}`,
      ),
      context.commands.length > 0
        ? `Commands: ${context.commands.map((command) => `${command.cwd === "." ? "" : `${command.cwd}: `}${command.command}`).join("; ")}`
        : "",
      context.environment.length > 0
        ? `Environment variables (names only): ${context.environment.map((entry) => `${entry.name} (${entry.scope}, ${entry.storage})`).join(", ")}`
        : "",
      context.acceptance.length > 0
        ? `Acceptance: ${context.acceptance.map((entry) => entry.command).join("; ")}`
        : "",
      ...context.conventions.map((convention) => `Convention: ${convention}`),
      ...context.gaps.slice(0, 5).map((gap) => `Known gap: ${gap}`),
    ];
    return lines.filter((line) => line !== "").join("\n");
  };
}
