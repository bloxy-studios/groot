/**
 * The action policy a project grants, read from its groot.json — the one
 * loader apply (CLI and MCP) and resume share. It fails closed: a groot.json
 * that is unreadable, invalid, or of an unknown version is an error
 * (GROOT_E_INVALID_DOCUMENT / GROOT_E_UNSUPPORTED_SCHEMA), never a silent
 * fall back to the permissive default — a restrictive policy must not vanish
 * because an unrelated field is wrong. Only a project without a v2 blueprint
 * (no groot.json yet, or a v1 manifest, which has no policy) gets
 * DEFAULT_POLICY, as documented for unregistered projects.
 */
import { readManifest } from "../blueprint/manifest.ts";
import { DEFAULT_POLICY, type Policy } from "../contracts/blueprint.ts";

export interface PolicySource {
  readonly policy: Policy;
  readonly source: "groot.json" | "default";
}

export async function loadProjectPolicy(root: string): Promise<PolicySource> {
  const manifest = await readManifest(root);
  return manifest.state === "v2"
    ? { policy: manifest.doc.policy, source: "groot.json" }
    : { policy: DEFAULT_POLICY, source: "default" };
}
