/**
 * Registration: whether (and how) the project is registered with Groot, read
 * through core/blueprint readManifest — so discovery and every planner agree
 * on what counts as a valid groot.json. A broken or too-new groot.json is a
 * registration *state* here (invalid / unsupported-version), not a crash:
 * `groot inspect` must keep working on exactly the projects that need help.
 *
 * Contradictions between desired state (groot.json) and the disk are
 * reported, never reconciled: a recorded scaffold/app whose package.json is
 * missing, or whose framework dependency is absent.
 */
import { type ManifestRead, readManifest } from "../blueprint/manifest.ts";
import { UnitPath } from "../contracts/common.ts";
import type { ProjectUnit, Registration } from "../contracts/project.ts";
import { GrootV2Error } from "../errors.ts";
import { joinRel } from "../fs/paths.ts";
import type { ContradictionNote } from "./facts.ts";
import { FRAMEWORK_PACKAGES } from "./frameworks.ts";
import { joinProjectPath, type ProjectFs } from "./fs.ts";
import { declaredPackages, packageFields } from "./package-fields.ts";

export interface RegistrationFindings {
  readonly registration: Registration;
  readonly manifest: ManifestRead | null;
}

const MANIFEST_PATH = "groot.json";

export async function observeRegistration(root: string): Promise<RegistrationFindings> {
  try {
    const manifest = await readManifest(root);
    const registration: Registration =
      manifest.state === "absent"
        ? { status: "unregistered", manifestPath: null, version: null, error: null }
        : {
            status: manifest.state,
            manifestPath: MANIFEST_PATH,
            version: manifest.state === "v1" ? 1 : 2,
            error: null,
          };
    return { registration, manifest };
  } catch (error) {
    if (!(error instanceof GrootV2Error)) throw error;
    const version = error.details?.version;
    const status =
      error.id === "GROOT_E_UNSUPPORTED_SCHEMA"
        ? "unsupported-version"
        : error.id === "GROOT_E_INVALID_DOCUMENT" || error.id === "GROOT_E_PATH_OUTSIDE_PROJECT"
          ? "invalid"
          : null;
    if (status === null) throw error;
    return {
      registration: {
        status,
        manifestPath: MANIFEST_PATH,
        version: typeof version === "number" && Number.isInteger(version) ? version : null,
        error: error.message,
      },
      manifest: null,
    };
  }
}

interface Recorded {
  readonly what: string;
  readonly path: string;
  readonly framework: string | null;
}

/** v1: the scaffolds; v2: the apps (which already include every generated scaffold). */
function recordedEntries(manifest: ManifestRead): Recorded[] {
  if (manifest.state === "absent") return [];
  if (manifest.state === "v1") {
    return manifest.doc.scaffolds.map((scaffold, index) => ({
      what: `scaffold ${index} (${scaffold.framework})`,
      path: scaffold.path,
      framework: scaffold.framework,
    }));
  }
  return manifest.doc.apps.map((app) => ({
    what: `app "${app.id}"${app.framework === null ? "" : ` (${app.framework})`}`,
    path: app.path,
    framework: app.framework,
  }));
}

async function declaredDependencies(
  fs: ProjectFs,
  path: string,
  units: readonly ProjectUnit[],
): Promise<Record<string, string> | null> {
  const unit = units.find((entry) => entry.path === path);
  if (unit !== undefined) return { ...unit.devDependencies, ...unit.dependencies };
  const file = await fs.readText(joinProjectPath(path, "package.json"));
  if (file === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    return {}; // present but unparseable: reported by unit analysis, not as a contradiction
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return declaredPackages(packageFields(value as Record<string, unknown>));
}

/** groot.json entries that the disk contradicts. */
export async function manifestContradictions(
  fs: ProjectFs,
  manifest: ManifestRead | null,
  units: readonly ProjectUnit[],
): Promise<ContradictionNote[]> {
  if (manifest === null) return [];
  const contradictions: ContradictionNote[] = [];
  for (const entry of recordedEntries(manifest)) {
    const parsed = UnitPath.safeParse(joinRel(entry.path));
    if (!parsed.success) continue; // readManifest-valid but not a project path: nothing to compare
    const packageJson = joinProjectPath(parsed.data, "package.json");
    const deps = await declaredDependencies(fs, parsed.data, units);
    if (deps === null) {
      contradictions.push({
        topic: "blueprint",
        explanation: `groot.json records ${entry.what} at ${parsed.data}, but ${packageJson} is missing`,
        sources: [MANIFEST_PATH, packageJson],
      });
      continue;
    }
    const packages = entry.framework === null ? undefined : FRAMEWORK_PACKAGES[entry.framework];
    if (packages !== undefined && packages.length > 0 && !packages.some((name) => name in deps)) {
      contradictions.push({
        topic: "blueprint",
        explanation: `groot.json records ${entry.what} at ${parsed.data}, but ${packageJson} declares none of ${packages.join(", ")}`,
        sources: [MANIFEST_PATH, packageJson],
      });
    }
  }
  return contradictions;
}
