/**
 * Tool-result shaping for MCP clients. Both Claude Code and Codex show the
 * model only `structuredContent` when it is present, so every result leads
 * with a `summary` and explicit `next` steps; one text block mirrors it for
 * other clients. Domain errors are `isError` results whose FIRST text block
 * is self-contained (stable GROOT_E_* code + remediation) — Claude Code shows
 * only that block. Secret redaction applies to everything that leaves.
 */
import type { ErrorId, ErrorInfo } from "../contracts/envelope.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { blockedDecisions, toErrorInfo } from "../errors.ts";
import { redactValue } from "../redact.ts";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Structured {
  readonly summary: string;
  readonly next: readonly string[];
  readonly [key: string]: unknown;
}

export function ok(structured: Structured): ToolResult {
  const safe = redactValue({ ...structured, next: [...structured.next] });
  return { content: [{ type: "text", text: JSON.stringify(safe) }], structuredContent: safe };
}

const NEXT_BY_ERROR: Partial<Record<ErrorId, string>> = {
  GROOT_E_STALE_PLAN:
    "Files changed after planning. Call plan_add (or plan_context_sync) again to re-plan against the current files, then apply the new planId.",
  GROOT_E_POLICY_DENIED:
    "Ask the user to approve the denied action classes listed in error.details, then call operation_apply again with allow set to them.",
  GROOT_E_LOCKED:
    "Another groot process is changing this project. Call operation_status (no id) and retry when it finishes.",
  GROOT_E_MIGRATION_REQUIRED:
    "This is a groot v1 workspace. Ask the user to run `groot migrate` (an explicit, previewable migration).",
  GROOT_E_NOT_REGISTERED:
    "The project is not registered. Ask the user to preview `groot adopt --dry-run` and adopt it first.",
  GROOT_E_INCOMPATIBLE:
    "Choose one of the alternatives in error.details.refusals and call plan_add again.",
  GROOT_E_UNKNOWN_CAPABILITY:
    "Call describe to list capabilities and recipes, then call plan_add with a known one.",
  GROOT_E_CONFLICT:
    "Resolve the conflicting file(s) named in error.details (never overwrite human edits), then re-plan.",
  GROOT_E_ROLLBACK_CONFLICT:
    "Files were edited after the operation; rollback refused to overwrite them. Revert or keep those edits manually.",
  GROOT_E_INTERRUPTED:
    "The operation was interrupted at a checkpoint. Call operation_resume with its operationId.",
  GROOT_E_BLOCKED:
    "A decision or prerequisite is missing — blocked[] has the question, the options, and resolveWith. A CLI flag such as --target or --recipe is the same-named tool argument: `groot plan add a,b --target <app> --recipe <id>` is plan_add with capabilities [{capability: a, target, recipe}, {capability: b, target}]. Resolve it with the user, then retry.",
  GROOT_E_RUNNER_UNAVAILABLE:
    "The coding agent is not installed or not logged in. Ask the user to fix that, then retry.",
};

/**
 * The follow-up for an error. A denied `external` class is never something
 * the agent can approve (operation_apply refuses allow=external), so it gets
 * a person-at-a-terminal step instead of the generic "approve and retry".
 */
function nextStepFor(info: ErrorInfo): string | undefined {
  const details = (info.details ?? {}) as {
    denied?: unknown;
    planId?: unknown;
    operationId?: unknown;
  };
  if (
    info.id === "GROOT_E_POLICY_DENIED" &&
    Array.isArray(details.denied) &&
    details.denied.includes("external")
  ) {
    const command =
      typeof details.planId === "string"
        ? `groot apply ${details.planId} --allow external`
        : typeof details.operationId === "string"
          ? `groot resume ${details.operationId} --allow external`
          : "groot apply <planId> --allow external";
    return `External effects need a person's approval: ask the user to review the change and run \`${command}\` in a terminal, then call operation_status to follow the operation.`;
  }
  return NEXT_BY_ERROR[info.id];
}

export function fail(error: unknown): ToolResult {
  const info: ErrorInfo = toErrorInfo(error);
  const next = nextStepFor(info);
  const text = `${info.id}: ${info.message}${info.hint ? ` — ${info.hint}` : ""}${next ? ` Next: ${next}` : ""}`;
  // Like the CLI envelope: a blocked (exit 7) error always lists what resolves it.
  const blocked = blockedDecisions(error, info);
  const structured = redactValue({ summary: text, error: info, blocked, next: next ? [next] : [] });
  return {
    isError: true,
    content: [{ type: "text", text: redactValue(text) }],
    structuredContent: structured,
  };
}

/** Compact, model-sized view of a plan (full documents via plan_get). */
export function planDigest(plan: OperationPlan): Record<string, unknown> {
  return {
    planId: plan.planId,
    fingerprint: plan.fingerprint,
    intent: plan.intent.type,
    selections: plan.capabilities.selections.map(
      (selection) =>
        `${selection.capability} via ${selection.recipe} on ${selection.target}${selection.alreadySatisfied ? " (already present)" : ""}`,
    ),
    actions: plan.actions.map((action) => ({
      id: action.id,
      type: action.type,
      target:
        "path" in action
          ? action.path
          : action.type === "file.move"
            ? `${action.from} → ${action.to}`
            : action.type === "command.run" || action.type === "generator.run"
              ? action.argv.join(" ")
              : action.type === "deps.add"
                ? action.unit
                : action.type === "external"
                  ? `${action.provider}: ${action.effect}`
                  : "",
      description: action.description,
      reversible: action.reversible,
    })),
    dependencies: plan.dependencies.map(
      (change) => `${change.unit}: ${change.package}@${change.to}${change.dev ? " (dev)" : ""}`,
    ),
    environment: plan.environment.map((contract) => ({
      name: contract.name,
      consumer: contract.consumer,
      scope: contract.scope,
      sensitivity: contract.sensitivity,
      required: contract.required,
      storage: contract.storage,
    })),
    externalEffects: plan.external.length,
    requiredClasses: plan.requiredClasses,
    preconditions: plan.preconditions.length,
    verification: plan.verification.map((contract) => `${contract.profile}: ${contract.id}`),
    recovery: plan.recovery,
    assumptions: plan.assumptions,
  };
}
