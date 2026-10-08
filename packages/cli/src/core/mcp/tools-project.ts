/**
 * Read and plan tools: discovery, task context, plan creation/inspection,
 * verification, and evidence. Planning tools persist plans but never change
 * the project; applying is a separate, explicit tool.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { VerificationProfile } from "../contracts/common.ts";
import { createContext } from "../runtime.ts";
import type { ToolDeps } from "./deps.ts";
import { fail, ok, planDigest } from "./results.ts";

const Root = z
  .string()
  .optional()
  .describe("Absolute path of the project (default: the directory groot mcp was started in)");

const Summary = z.looseObject({
  summary: z.string().describe("One-paragraph result for the model"),
  next: z.array(z.string()).describe("Explicit follow-up steps"),
});

export function registerProjectTools(server: McpServer, deps: ToolDeps): void {
  const ctxFor = (root: string, signal: AbortSignal) =>
    createContext({ cwd: root, signal, events: deps.events });
  const rootOf = (input: string | undefined): string => deps.api.projectRoot(input ?? deps.cwd);

  server.registerTool(
    "describe",
    {
      title: "Describe groot",
      description:
        "groot version, the capabilities and recipes this build can plan, published contract schemas, and stable error codes. Call first in a new session.",
      inputSchema: z.strictObject({}),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const info = await deps.api.describe();
        return ok({
          summary: `groot ${info.grootVersion}: capabilities ${info.capabilities.map((entry) => `${entry.id} (${entry.recipes.join(", ") || "no recipes"})`).join("; ")}.`,
          next: [
            "Call project_inspect or context_get for the current project, then plan_add to preview a change.",
          ],
          ...info,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "project_inspect",
    {
      title: "Inspect project",
      description:
        "Read-only discovery: apps/packages, topology, package manager, toolchains, agent instruction files, git state, registration, support level, unknowns and contradictions. Facts carry source and confidence. Never executes project code.",
      inputSchema: z.strictObject({ root: Root }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const observation = await deps.api.inspect(
          ctxFor(projectRoot, ctx.mcpReq.signal),
          projectRoot,
        );
        return ok({
          summary: `${observation.name.value ?? projectRoot}: ${observation.topology.value} ${observation.packageManager.value} project with ${observation.units.length} unit(s); registration ${observation.registration.status}; writable support ${observation.support.level}.`,
          next:
            observation.registration.status === "v2"
              ? ["Call context_get with a task, or plan_add to add a capability."]
              : [
                  observation.support.nextStep ??
                    "Ask the user to preview `groot adopt --dry-run` to register the project.",
                ],
          observation,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "context_get",
    {
      title: "Task context",
      description:
        "Concise, task-scoped project knowledge: relevant apps, commands, environment variable NAMES and where they live, decisions, acceptance checks, latest evidence, and known gaps — with sources. Never includes secret values.",
      inputSchema: z.strictObject({
        root: Root,
        task: z
          .string()
          .optional()
          .describe("What you are about to do, in a sentence (omit for the whole project)"),
      }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, task }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const context = await deps.api.context(
          ctxFor(projectRoot, ctx.mcpReq.signal),
          projectRoot,
          task ?? null,
        );
        return ok({
          summary: `${context.units.length} relevant unit(s) for ${task ? `"${task}"` : "the project"}; ${context.acceptance.length} acceptance check(s); ${context.gaps.length} known gap(s).`,
          next:
            context.acceptance.length > 0
              ? ["Run the acceptance checks with verify_run after changing code."]
              : [],
          context,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "plan_add",
    {
      title: "Plan a capability",
      description:
        "Preview adding capabilities (e.g. auth, data) to a registered project: resolves requirements and conflicts, then lists every file write/edit, dependency, command, environment variable, verification, and recovery limit. Changes nothing in the project — apply with operation_apply. Refusals return alternatives.",
      inputSchema: z.strictObject({
        root: Root,
        capabilities: z
          .array(
            z.strictObject({
              capability: z.string().describe("Capability id, e.g. auth or data (see describe)"),
              recipe: z.string().optional().describe("Specific recipe id when several fit"),
              target: z.string().optional().describe("App id or path when several apps fit"),
            }),
          )
          .min(1)
          .describe("Capabilities to add; requirements are added automatically"),
        experimental: z.boolean().optional().describe("Allow recipes that are not certified yet"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ root, capabilities, experimental }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const plan = await deps.api.planAdd(
          ctxFor(projectRoot, ctx.mcpReq.signal),
          projectRoot,
          capabilities,
          {
            experimental: experimental ?? false,
          },
        );
        return ok({
          summary: `Plan ${plan.planId}: ${plan.summary} — ${plan.actions.length} step(s), ${plan.dependencies.length} dependency change(s); recovery ${plan.recovery.mode}.`,
          next:
            plan.actions.length === 0
              ? []
              : [
                  `Review the steps with the user, then call operation_apply with planId=${plan.planId}.`,
                ],
          plan: planDigest(plan),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "plan_context_sync",
    {
      title: "Plan agent-context sync",
      description:
        "Preview refreshing the groot-managed sections of AGENTS.md and CLAUDE.md and the groot skill files. Human text outside the managed markers is never changed; hand-edited managed regions are reported as conflicts.",
      inputSchema: z.strictObject({
        root: Root,
        skipConflicts: z
          .boolean()
          .optional()
          .describe("Sync everything else and report conflicting files"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ root, skipConflicts }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const result = await deps.api.planContextSync(
          ctxFor(projectRoot, ctx.mcpReq.signal),
          projectRoot,
          skipConflicts ?? false,
        );
        const changed = result.changes.filter((change) => change.action !== "unchanged");
        return ok({
          summary:
            changed.length === 0
              ? "Agent context is already in sync."
              : `Plan ${result.plan.planId}: ${changed.map((change) => `${change.action} ${change.path}`).join(", ")}.`,
          next:
            result.plan.actions.length > 0
              ? [`Call operation_apply with planId=${result.plan.planId}.`]
              : [],
          plan: planDigest(result.plan),
          changes: result.changes,
          warnings: result.warnings,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "plan_get",
    {
      title: "Get a plan",
      description:
        "The full plan document (including exact file contents and previews) for a planId.",
      inputSchema: z.strictObject({
        root: Root,
        planId: z.string().describe("Plan id from plan_add"),
      }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, planId }) => {
      try {
        const plan = await deps.api.getPlan(rootOf(root), planId);
        return ok({
          summary: plan.summary,
          next: [`Call operation_apply with planId=${plan.planId}.`],
          plan,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "verify_run",
    {
      title: "Verify",
      description:
        "Run verification and record evidence. Profiles: structural (offline, fast), build (typecheck/build scripts), runtime (start the app on a free port and probe it), product-flow (drive the real flow, e.g. sign-up → protected data → unauthorized rejection). Results are pass/fail/skipped/blocked per check, tied to the revision checked.",
      inputSchema: z.strictObject({
        root: Root,
        profiles: z.array(VerificationProfile).optional().describe("Default: structural and build"),
        capability: z.string().optional().describe("Limit to one capability's checks, e.g. auth"),
      }),
      outputSchema: Summary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ root, profiles, capability }, ctx) => {
      try {
        const projectRoot = rootOf(root);
        const report = await deps.api.verify(ctxFor(projectRoot, ctx.mcpReq.signal), projectRoot, {
          profiles: profiles ?? ["structural", "build"],
          capability: capability ?? null,
        });
        const failing = report.evidence.filter(
          (entry) => entry.status === "fail" || entry.status === "blocked",
        );
        return ok({
          summary: `Verification ${report.ok ? "found no failures" : "FAILED"}: ${Object.entries(
            report.profiles,
          )
            .map(([profile, entry]) => `${profile} ${entry.status}`)
            .join(", ")}.`,
          next: failing.map(
            (entry) =>
              `${entry.check} is ${entry.status}: ${entry.nextStep ?? entry.summary} (evidence ${entry.id})`,
          ),
          profiles: report.profiles,
          revision: report.revision,
          evidence: report.evidence.map((entry) => ({
            id: entry.id,
            check: entry.check,
            profile: entry.profile,
            status: entry.status,
            summary: entry.summary,
            reason: entry.reason,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "evidence_get",
    {
      title: "Get evidence",
      description: "One evidence record with details, limitations, and redacted artifact paths.",
      inputSchema: z.strictObject({ root: Root, id: z.string().describe("Evidence id (ev_…)") }),
      outputSchema: Summary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, id }) => {
      try {
        const evidence = await deps.api.getEvidence(rootOf(root), id);
        return ok({
          summary: `${evidence.check}: ${evidence.status} — ${evidence.summary}`,
          next: [],
          evidence,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
