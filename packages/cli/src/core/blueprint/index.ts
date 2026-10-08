/**
 * core/blueprint — groot.json (desired state) and groot.lock.json I/O:
 * read + validate (v1 manifest or v2 blueprint), canonical serialization,
 * the deterministic v1 → v2 migration, the adoption blueprint, and lock
 * helpers. Pure functions plus reads; every write goes through a plan.
 */
export { ADOPTION_TOPIC, type AdoptionOptions, blueprintFromObservation } from "./adopt.ts";
export type { DocumentIssue } from "./document.ts";
export {
  emptyLock,
  type LockRead,
  migrationLock,
  parseGeneratorSpec,
  readLock,
  unresolvedGeneratorLocks,
} from "./lock.ts";
export { MANIFEST_FILE, type ManifestRead, readManifest } from "./manifest.ts";
export { MIGRATION_TOPIC, migrateV1ToV2 } from "./migrate.ts";
export { orderBySchema, serializeBlueprint, serializeLock } from "./serialize.ts";
