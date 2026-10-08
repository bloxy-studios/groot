/**
 * Turning a recipe's app-independent contract templates (RecipeDescriptor.env
 * and .verification) into the concrete contracts a plan records for one app:
 * env contracts gain their consumer and storage file, verification contracts
 * their unit and an app-qualified id (so the same recipe on two apps yields
 * two independent checks the engine won't deduplicate).
 */
import type { BlueprintApp } from "../contracts/blueprint.ts";
import type { RecipeDescriptor } from "../contracts/capability.ts";
import type { EnvVarContract, VerificationContract } from "../contracts/common.ts";
import type { RecipeLayout } from "./layout.ts";

export const NEEDS_NOTHING: VerificationContract["needs"] = {
  network: false,
  processes: false,
  credentials: [],
  toolchains: [],
};

/** Local processes only: the checks bind loopback and never reach the network. */
export const NEEDS_BUN: VerificationContract["needs"] = {
  network: false,
  processes: true,
  credentials: [],
  toolchains: ["bun"],
};

export function verificationFor(
  templates: RecipeDescriptor["verification"],
  app: BlueprintApp,
): VerificationContract[] {
  return templates.map((template) => ({
    ...template,
    id: `${template.id}.${app.id}`,
    unit: app.path,
  }));
}

export function envFor(
  templates: RecipeDescriptor["env"],
  layout: RecipeLayout,
  examples: Readonly<Record<string, string>> = {},
): EnvVarContract[] {
  return templates.map((template) => ({
    ...template,
    example: examples[template.name] ?? template.example,
    consumer: layout.appDir,
    storage: layout.envLocal,
  }));
}
