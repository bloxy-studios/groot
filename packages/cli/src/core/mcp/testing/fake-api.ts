/**
 * A contract-valid fake of the core API for MCP protocol tests (never shipped:
 * only test entries import it). Operations whose plan summary contains "slow"
 * run for 30 s unless cancelled; everything else completes immediately. The
 * fake also writes to console.log on purpose, to prove the stdout guard.
 */
import { schemaUrl } from "../../contracts/common.ts";
import type { OperationResult, OperationState } from "../../contracts/operation.ts";
import type { OperationPlan } from "../../contracts/plan.ts";
import type { Task } from "../../contracts/task.ts";
import { GrootV2Error } from "../../errors.ts";
import { newId, nowIso } from "../../ids.ts";
import { PlanBuilder } from "../../planner/builder.ts";
import { observationFixture, unitFixture } from "../../test-fixtures.ts";
import type { GrootApi } from "../api.ts";

const REVISION = {
  vcs: "none" as const,
  head: null,
  branch: null,
  dirty: false,
  worktreeFingerprint: null,
};
const ENV = { os: "test", arch: "test", bun: "test", groot: "test", ci: true };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function createFakeApi(): GrootApi {
  const plans = new Map<string, OperationPlan>();
  const operations = new Map<string, OperationState>();
  const tasks = new Map<string, Task>();

  const state = (plan: OperationPlan, status: OperationState["status"]): OperationState => ({
    $schema: schemaUrl("operation"),
    schemaVersion: 1,
    kind: "groot.operation",
    operationId: newId("op"),
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    intent: plan.intent,
    summary: plan.summary,
    status,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    steps: plan.actions.map((action) => ({
      id: action.id,
      type: action.type,
      description: action.description,
      status: "pending",
      outcome: null,
      reversible: action.reversible,
    })),
    currentStep: null,
    error: null,
    evidence: [],
    resumable: false,
    journal: "x.jsonl",
  });

  const result = (op: OperationState, alreadyApplied = false): OperationResult => ({
    $schema: schemaUrl("operation-result"),
    schemaVersion: 1,
    kind: "groot.operation-result",
    operationId: op.operationId,
    planId: op.planId,
    status: op.status,
    alreadyApplied,
    steps: op.steps,
    evidence: [],
    nextSteps: [],
    error: null,
  });

  return {
    async describe() {
      console.log("noise from core code that must never reach stdout");
      return {
        grootVersion: "test",
        contracts: [{ name: "plan", title: "Operation plan", url: schemaUrl("plan") }],
        capabilities: [{ id: "auth", title: "Authentication", recipes: ["auth.better-auth"] }],
        errorIds: [{ id: "GROOT_E_STALE_PLAN", exitCode: 6 }],
      };
    },
    projectRoot: (dir) => dir,
    async inspect(_ctx, root) {
      return observationFixture([unitFixture({ path: "apps/api" })], root);
    },
    async context(_ctx, _root, task) {
      return {
        $schema: schemaUrl("context"),
        schemaVersion: 1,
        kind: "groot.context",
        task,
        project: { name: "fake", topology: "monorepo", registered: true, revision: REVISION },
        units: [],
        capabilities: [],
        decisions: [],
        conventions: [],
        commands: [],
        environment: [],
        acceptance: [],
        evidence: [],
        gaps: [],
        sources: ["fake"],
      };
    },
    async planAdd(_ctx, root, requests) {
      if (requests.some((request) => request.capability === "billing")) {
        throw new GrootV2Error("GROOT_E_UNKNOWN_CAPABILITY", 'Unknown capability "billing".', {
          details: {
            refusals: [
              { code: "unknown-capability", message: "billing", alternatives: ["auth", "data"] },
            ],
          },
        });
      }
      const builder = new PlanBuilder({
        root,
        intent: {
          type: "add-capability",
          capabilities: requests.map((r) => r.capability),
          target: null,
          recipe: null,
          options: {},
        },
        summary: `add ${requests.map((r) => r.capability).join(" + ")}${requests.some((r) => r.target === "slow") ? " (slow)" : ""}`,
        topology: "monorepo",
        revision: REVISION,
        createdWith: "create-groot@test",
      });
      builder.add({
        type: "file.write",
        path: "apps/api/src/feature.ts",
        content: "export {};\n",
        sha256: `sha256:${"0".repeat(64)}`,
        expect: { state: "absent" },
        ownership: "file",
        executable: false,
        description: "create feature.ts",
        classes: ["fs.create"],
        reversible: true,
        compensation: "delete it",
      });
      const plan = builder.build();
      plans.set(plan.planId, plan);
      return plan;
    },
    async planContextSync(ctx, root) {
      const plan = await this.planAdd(ctx, root, [{ capability: "context" }], {
        experimental: false,
      });
      return { plan, changes: [], warnings: [] };
    },
    async getPlan(_root, planId) {
      const plan = plans.get(planId);
      if (plan === undefined) throw new GrootV2Error("GROOT_E_NOT_FOUND", `No plan ${planId}.`);
      return plan;
    },
    async apply(ctx, _root, plan) {
      const done = [...operations.values()].find(
        (op) => op.planId === plan.planId && op.status === "completed",
      );
      if (done !== undefined) return result(done, true);
      const op = state(plan, "running");
      operations.set(op.operationId, op);
      try {
        await sleep(plan.summary.includes("slow") ? 30_000 : 50, ctx.signal);
      } catch {
        operations.set(op.operationId, { ...op, status: "interrupted", resumable: true });
        throw new GrootV2Error(
          "GROOT_E_INTERRUPTED",
          `Operation ${op.operationId} interrupted at a checkpoint.`,
        );
      }
      const completed: OperationState = {
        ...op,
        status: "completed",
        steps: op.steps.map((step) => ({ ...step, status: "done", outcome: "applied" })),
      };
      operations.set(op.operationId, completed);
      return result(completed);
    },
    async resume(_ctx, _root, operationId) {
      const op = operations.get(operationId);
      if (op === undefined)
        throw new GrootV2Error("GROOT_E_NOT_FOUND", `No operation ${operationId}.`);
      const completed: OperationState = { ...op, status: "completed", resumable: false };
      operations.set(operationId, completed);
      return result(completed);
    },
    async previewRollback(_ctx, _root, operationId) {
      return {
        $schema: schemaUrl("rollback"),
        schemaVersion: 1,
        kind: "groot.rollback",
        operationId,
        possible: true,
        steps: [],
        conflicts: [],
        irreversible: [],
        limits: [],
      };
    },
    async rollback(_ctx, _root, operationId) {
      const op = operations.get(operationId);
      if (op === undefined)
        throw new GrootV2Error("GROOT_E_NOT_FOUND", `No operation ${operationId}.`);
      const rolled: OperationState = { ...op, status: "rolled-back" };
      operations.set(operationId, rolled);
      return result(rolled);
    },
    async listOperations() {
      return [...operations.values()].reverse();
    },
    async readOperation(_root, operationId) {
      const op = operations.get(operationId);
      if (op === undefined)
        throw new GrootV2Error("GROOT_E_NOT_FOUND", `No operation ${operationId}.`);
      return op;
    },
    async verify(_ctx, root) {
      const summary = { status: "not-run" as const, pass: 0, fail: 0, skipped: 0, blocked: 0 };
      return {
        $schema: schemaUrl("verification"),
        schemaVersion: 1,
        kind: "groot.verification",
        root,
        revision: REVISION,
        environment: ENV,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        scope: { capability: null, profiles: ["structural"] },
        profiles: {
          structural: { ...summary, status: "pass", pass: 1 },
          build: summary,
          runtime: summary,
          "product-flow": summary,
        },
        evidence: [],
        ok: true,
      };
    },
    async getEvidence(_root, id) {
      throw new GrootV2Error("GROOT_E_NOT_FOUND", `No evidence ${id}.`);
    },
    async createTask(_ctx, _root, request) {
      const task: Task = {
        $schema: schemaUrl("task"),
        schemaVersion: 1,
        kind: "groot.task",
        id: newId("task"),
        title: request.title ?? request.objective.slice(0, 60),
        objective: request.objective,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        runner: request.runner,
        model: request.model ?? null,
        dependsOn: [...(request.dependsOn ?? [])],
        ownership: [...(request.ownership ?? ["**"])],
        acceptance: [],
        limits: { wallTimeSec: 900, maxTurns: 25, maxBudgetUsd: 2, maxAttempts: 2 },
        status: "pending",
        statusReason: null,
        base: { branch: "main", commit: "0".repeat(40) },
        worktree: null,
        attempts: [],
        evidence: [],
        review: null,
        integration: null,
      };
      tasks.set(task.id, task);
      return task;
    },
    async listTasks() {
      return [...tasks.values()];
    },
    async readTask(_root, id) {
      const task = tasks.get(id);
      if (task === undefined) throw new GrootV2Error("GROOT_E_NOT_FOUND", `No task ${id}.`);
      return task;
    },
    async runTask(_ctx, _root, id) {
      const task = tasks.get(id);
      if (task === undefined) throw new GrootV2Error("GROOT_E_NOT_FOUND", `No task ${id}.`);
      const next: Task = { ...task, status: "awaiting-review" };
      tasks.set(id, next);
      return next;
    },
    async reviewTask(_ctx, _root, id, decision) {
      return {
        $schema: schemaUrl("review"),
        schemaVersion: 1,
        kind: "groot.review",
        id: newId("rev"),
        taskId: id,
        createdAt: nowIso(),
        base: "a",
        head: "b",
        files: [],
        acceptance: [],
        ownershipViolations: [],
        secretFindings: [],
        verdict: decision.approve ? "approved" : "pending",
        reviewer: decision.approve ? "human" : null,
        notes: null,
      };
    },
    async integrateTask(_ctx, _root, id) {
      const task = tasks.get(id);
      if (task === undefined) throw new GrootV2Error("GROOT_E_NOT_FOUND", `No task ${id}.`);
      const done: Task = { ...task, status: "completed" };
      tasks.set(id, done);
      return done;
    },
  };
}
