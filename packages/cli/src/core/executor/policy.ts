/**
 * Action-policy enforcement. The executor is the single choke point every
 * surface (CLI, MCP, task runners) goes through, so the policy check lives
 * here rather than in any presentation layer.
 *
 * Because a plan file is untrusted, the classes it needs are not taken only
 * from its own `requiredClasses`: every action's declared classes count too,
 * plus the classes an action type intrinsically implies (a command runs a
 * process, a dependency change edits a manifest, …). A hand-edited plan that
 * under-declares its effects is therefore still held to the policy.
 */
import type { Policy } from "../contracts/blueprint.ts";
import type { ActionClass } from "../contracts/common.ts";
import type { OperationPlan, PlannedAction } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";

/** Classes that already describe "a process runs" — a command needs one of them. */
const EXECUTION_CLASSES: readonly ActionClass[] = ["command", "install", "git", "process"];

/** Classes an action needs regardless of what the document declares. */
function intrinsicClasses(action: PlannedAction): ActionClass[] {
  switch (action.type) {
    case "file.delete":
      return ["fs.delete"];
    case "file.move":
      return ["fs.move"];
    case "deps.add":
      return ["deps.change"];
    case "generator.run":
      return ["generator"];
    case "external":
      return ["external"];
    case "command.run": {
      const needs: ActionClass[] = action.network ? ["network"] : [];
      const executes = action.classes.some((cls) => EXECUTION_CLASSES.includes(cls));
      return executes ? needs : [...needs, "command"];
    }
    default:
      return [];
  }
}

/** Every class the plan needs: declared at plan level, per action, and intrinsic. */
export function requiredClasses(plan: OperationPlan): ActionClass[] {
  const all = new Set<ActionClass>(plan.requiredClasses);
  for (const action of plan.actions) {
    for (const cls of action.classes) all.add(cls);
    for (const cls of intrinsicClasses(action)) all.add(cls);
  }
  if (plan.external.length > 0) all.add("external");
  return [...all].sort();
}

/**
 * Classes the policy (plus explicit approvals) does not permit. External
 * effects are never implicit: they additionally need `policy.external: "ask"`
 * AND an explicit "external" approval for this run.
 */
export function deniedClasses(
  plan: OperationPlan,
  policy: Policy,
  approvals: readonly ActionClass[],
): ActionClass[] {
  const allowed = new Set<ActionClass>([...policy.allow, ...approvals]);
  const denied = new Set<ActionClass>();
  for (const cls of requiredClasses(plan)) {
    if (cls === "external") {
      if (policy.external !== "ask" || !approvals.includes("external")) denied.add(cls);
      continue;
    }
    if (!allowed.has(cls)) denied.add(cls);
  }
  return [...denied].sort();
}

/** Throw GROOT_E_POLICY_DENIED (details.denied) when any required class is not permitted. */
export function assertPolicy(
  plan: OperationPlan,
  policy: Policy,
  approvals: readonly ActionClass[],
): void {
  const denied = deniedClasses(plan, policy, approvals);
  if (denied.length === 0) return;
  const external = denied.includes("external");
  throw new GrootV2Error(
    "GROOT_E_POLICY_DENIED",
    `The plan needs action classes the project policy does not allow: ${denied.join(", ")}.`,
    {
      hint: external
        ? 'External effects need policy.external "ask" in groot.json plus an explicit approval (--allow external).'
        : `Approve them for this run (--allow ${denied.join(",")}) or extend policy.allow in groot.json.`,
      details: { denied, planId: plan.planId, policy },
    },
  );
}
