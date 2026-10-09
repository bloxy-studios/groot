/**
 * planMigrate — the explicit, previewable v1 → v2 groot.json migration
 * (`groot migrate`). The plan replaces groot.json only if it still has the
 * exact bytes that were migrated (its sha256 is both the write's expected
 * state and a manifest precondition, so an edit after planning makes the
 * plan stale instead of being overwritten) and writes groot.lock.json with
 * the scaffold generators recorded as unresolved — migration is offline;
 * resolving exact versions is a later, separate operation.
 */

import { migrationLock } from "../blueprint/lock.ts";
import { MANIFEST_FILE, readManifest } from "../blueprint/manifest.ts";
import { migrateV1ToV2 } from "../blueprint/migrate.ts";
import { serializeBlueprint, serializeLock } from "../blueprint/serialize.ts";
import type { ManifestV1 } from "../contracts/blueprint.ts";
import type { Sha256 } from "../contracts/common.ts";
import { LOCK_FILE } from "../contracts/lock.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { inspect } from "../discovery/index.ts";
import { GrootV2Error } from "../errors.ts";
import type { CoreContext } from "../runtime.ts";
import {
  type RegistrationPlanOptions,
  registrationAssumptions,
  registrationBuilder,
  registrationOwnership,
  registrationVerification,
  validatedPlan,
} from "./adopt.ts";

const STATE_EXPLANATION: Record<string, { message: string; hint: string }> = {
  unregistered: {
    message: "has no groot.json — there is nothing to migrate",
    hint: "Register an existing project with groot adopt --dry-run, or create one with groot init.",
  },
  v2: {
    message: "already has a version 2 groot.json — there is nothing to migrate",
    hint: "See the project's state with groot status (or groot inspect).",
  },
  invalid: {
    message: "has a groot.json that cannot be read",
    hint: "Restore groot.json from version control (or fix the reported fields), then migrate.",
  },
  "unsupported-version": {
    message: "has a groot.json version this CLI does not read (it reads versions 1 and 2)",
    hint: "Use the groot release that wrote it, or upgrade groot (bunx create-groot@latest).",
  },
};

/** The v1 manifest to migrate, or GROOT_E_USAGE explaining the registration state. */
async function v1Manifest(
  observation: ProjectObservation,
): Promise<{ doc: ManifestV1; sha256: Sha256 }> {
  const { registration } = observation;
  if (registration.status === "v1") {
    const manifest = await readManifest(observation.root);
    if (manifest.state === "v1") return { doc: manifest.doc, sha256: manifest.sha256 };
  }
  if (registration.status === "invalid" || registration.status === "unsupported-version") {
    // The reader's own error names the problem and its one next step:
    // GROOT_E_INVALID_DOCUMENT or GROOT_E_UNSUPPORTED_SCHEMA (docs/v2-cli-spec.md).
    await readManifest(observation.root);
  }
  const explained = STATE_EXPLANATION[registration.status] ?? {
    message: "is not a groot version 1 workspace",
    hint: "Run groot inspect to see its registration state.",
  };
  const cause = registration.error === null ? "" : ` (${registration.error})`;
  throw new GrootV2Error(
    "GROOT_E_USAGE",
    `groot migrate needs a version 1 groot.json: ${observation.root} ${explained.message}${cause}.`,
    { hint: explained.hint, details: { registration } },
  );
}

/** Plan the v1 → v2 migration of `dir` (resolved against ctx.cwd; no walk-up). */
export async function planMigrate(
  ctx: CoreContext,
  dir: string,
  options: RegistrationPlanOptions = {},
): Promise<OperationPlan> {
  const observation = await inspect(ctx, dir, options);
  const manifest = await v1Manifest(observation);
  const builder = registrationBuilder(
    observation,
    { type: "migrate", from: 1, to: 2 },
    `Migrate groot.json from version 1 to version 2 (${manifest.doc.scaffolds.length} scaffold(s) become apps) and write groot.lock.json — no other file changes.`,
    "monorepo",
  );
  const now = options.now ?? new Date(builder.createdAt);
  const blueprint = migrateV1ToV2(manifest.doc, observation, now);
  await builder.writeFile({
    path: MANIFEST_FILE,
    content: serializeBlueprint(blueprint),
    replaceSha: manifest.sha256,
    description:
      "rewrite groot.json as a version 2 blueprint (createdWith, conventions, scaffolds kept verbatim)",
  });
  await builder.writeFile({
    path: LOCK_FILE,
    content: serializeLock(migrationLock(manifest.doc.scaffolds, now)),
    description:
      "write groot.lock.json — scaffold generators recorded as unresolved (migration is offline)",
  });
  builder.precondition({ type: "manifest", state: "v1", sha256: manifest.sha256 });
  registrationOwnership(builder, observation);
  registrationAssumptions(builder, observation);
  builder.assume(
    'Generator versions stay unresolved (source "unresolved", no version or integrity) until a later operation resolves them — migration makes no network request.',
  );
  builder.assume(
    "Existing v1 consumers keep working: createdWith, conventions, and scaffolds are carried over verbatim.",
  );
  registrationVerification(builder, blueprint);
  builder.setRecovery({
    mode: "full",
    summary:
      "Restoring the journaled version 1 groot.json and deleting groot.lock.json returns the workspace to its previous state.",
    irreversible: [],
    limits: [],
  });
  return validatedPlan(builder.build());
}
