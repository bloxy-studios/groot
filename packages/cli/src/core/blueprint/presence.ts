/**
 * Recorded apps the disk lacks. When groot.json records an app (or a v1
 * scaffold) whose directory — or that directory's package.json — is missing,
 * discovery reports a "blueprint" contradiction whose last source is the
 * missing path; the registration blueprints (adopt, migrate) read those
 * reports back to note the structural checks that will fail because of them.
 * Both sides live in this module, so the shape cannot drift between them.
 */
import type { ProjectObservation } from "../contracts/project.ts";
import { MANIFEST_FILE } from "./manifest.ts";

type Contradiction = ProjectObservation["contradictions"][number];

const TOPIC = "blueprint";

/**
 * The contradiction for an app groot.json records at `path` (described as
 * `what`) whose `missing` path — the directory itself, or its package.json —
 * is not on disk.
 */
export function missingRecordedApp(what: string, path: string, missing: string): Contradiction {
  return {
    topic: TOPIC,
    explanation: `groot.json records ${what} at ${path}, but ${missing} is missing`,
    sources: [MANIFEST_FILE, missing],
  };
}

/** Every recorded app directory or package.json that discovery reported missing. */
export function missingRecordedPaths(observation: ProjectObservation): Set<string> {
  const missing = new Set<string>();
  for (const { topic, explanation, sources } of observation.contradictions) {
    const [manifest, path, ...rest] = sources;
    if (topic !== TOPIC || manifest !== MANIFEST_FILE || path === undefined || rest.length > 0) {
      continue;
    }
    if (explanation.endsWith(`, but ${path} is missing`)) missing.add(path);
  }
  return missing;
}
