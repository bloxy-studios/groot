/**
 * Doctor stage (docs/cli-spec.md#groot-doctor-v03): workspace health checks with
 * suggested fixes. Structural checks run first, then each scaffold's adapter
 * contributes its own. All checks are offline and side-effect free.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import type { DoctorCheck } from "./adapter.ts";
import type { LoadedManifest } from "./manifest.ts";
import { MIN_BUN_VERSION, versionAtLeast } from "./preflight.ts";

/** Lockfiles that must not exist inside scaffold directories. */
const NESTED_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Run every health check for a loaded workspace. Never throws for unhealthy state. */
export async function runDoctor(loaded: LoadedManifest): Promise<DoctorCheck[]> {
  const { manifest, workspaceRoot } = loaded;
  const checks: DoctorCheck[] = [];

  // Bun version.
  const bunOk = versionAtLeast(Bun.version, MIN_BUN_VERSION);
  checks.push({
    name: "bun version",
    status: bunOk ? "pass" : "fail",
    detail: `v${Bun.version}${bunOk ? "" : ` — groot workspaces need ≥ ${MIN_BUN_VERSION}`}`,
    ...(bunOk ? {} : { fix: "Upgrade Bun: https://bun.sh" }),
  });

  // Root package.json + workspace globs.
  const rootPkg = await readJsonSafe(join(workspaceRoot, "package.json"));
  if (rootPkg === null) {
    checks.push({
      name: "root package.json",
      status: "fail",
      detail: "missing or unparseable",
      fix: "Restore the root package.json (name, private, workspaces).",
    });
  } else {
    const workspaces = Array.isArray(rootPkg.workspaces) ? (rootPkg.workspaces as string[]) : [];
    const missingGlobs = ["apps/*", "packages/*"].filter((glob) => !workspaces.includes(glob));
    checks.push({
      name: "workspace globs",
      status: missingGlobs.length === 0 ? "pass" : "fail",
      detail:
        missingGlobs.length === 0
          ? `[${workspaces.join(", ")}]`
          : `missing ${missingGlobs.join(", ")}`,
      ...(missingGlobs.length === 0
        ? {}
        : { fix: `Add ${missingGlobs.join(" and ")} to "workspaces" in the root package.json.` }),
    });
  }

  // Scaffold presence + unique package names.
  const seenNames = new Map<string, string>();
  for (const scaffold of manifest.scaffolds) {
    const pkgPath = join(workspaceRoot, scaffold.path, "package.json");
    const pkg = await readJsonSafe(pkgPath);
    if (pkg === null) {
      checks.push({
        name: `${scaffold.path} package`,
        status: "fail",
        detail: "package.json missing or unparseable",
        fix: `Restore ${scaffold.path}/package.json or remove the scaffold from groot.json.`,
      });
      continue;
    }
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const duplicate = seenNames.get(name);
    if (name === "") {
      checks.push({
        name: `${scaffold.path} package`,
        status: "fail",
        detail: "package has no name",
        fix: `Set "name" in ${scaffold.path}/package.json.`,
      });
    } else if (duplicate !== undefined) {
      checks.push({
        name: `${scaffold.path} package`,
        status: "fail",
        detail: `duplicate package name "${name}" (also ${duplicate})`,
        fix: "Give each workspace package a unique name.",
      });
    } else {
      seenNames.set(name, scaffold.path);
      checks.push({ name: `${scaffold.path} package`, status: "pass", detail: `"${name}"` });
    }
  }

  // Lockfile hygiene: exactly one, at the root.
  const rootLock = existsSync(join(workspaceRoot, "bun.lock"));
  checks.push({
    name: "root lockfile",
    status: rootLock ? "pass" : "warn",
    detail: rootLock ? "bun.lock present" : "bun.lock missing",
    ...(rootLock ? {} : { fix: "Run `bun install` at the workspace root." }),
  });
  const nested: string[] = [];
  for (const scaffold of manifest.scaffolds) {
    for (const lockfile of NESTED_LOCKFILES) {
      if (existsSync(join(workspaceRoot, scaffold.path, lockfile))) {
        nested.push(`${scaffold.path}/${lockfile}`);
      }
    }
  }
  checks.push({
    name: "nested lockfiles",
    status: nested.length === 0 ? "pass" : "fail",
    detail: nested.length === 0 ? "none" : nested.join(", "),
    ...(nested.length === 0
      ? {}
      : { fix: "Delete the nested lockfiles — the root bun.lock is the only one." }),
  });

  // Port collisions across the manifest.
  const portOwners = new Map<number, string[]>();
  for (const scaffold of manifest.scaffolds) {
    if (scaffold.port === null) continue;
    portOwners.set(scaffold.port, [...(portOwners.get(scaffold.port) ?? []), scaffold.path]);
  }
  const collisions = [...portOwners.entries()].filter(([, owners]) => owners.length > 1);
  checks.push({
    name: "dev ports",
    status: collisions.length === 0 ? "pass" : "fail",
    detail:
      collisions.length === 0
        ? [...portOwners.entries()].map(([port, [owner]]) => `${owner}:${port}`).join(" · ") ||
          "none assigned"
        : collisions
            .map(([port, owners]) => `:${port} shared by ${owners.join(" and ")}`)
            .join("; "),
    ...(collisions.length === 0
      ? {}
      : { fix: "Change the dev port of one scaffold (and update groot.json to match)." }),
  });

  // turbo.json parses and defines the core tasks every groot workspace ships with.
  const turbo = await readJsonSafe(join(workspaceRoot, "turbo.json"));
  const tasks =
    turbo !== null &&
    typeof turbo.tasks === "object" &&
    turbo.tasks !== null &&
    !Array.isArray(turbo.tasks)
      ? (turbo.tasks as Record<string, unknown>)
      : null;
  const REQUIRED_TASKS = ["build", "dev"];
  const missingTasks =
    tasks === null ? REQUIRED_TASKS : REQUIRED_TASKS.filter((task) => !(task in tasks));
  checks.push({
    name: "turbo config",
    status: tasks !== null && missingTasks.length === 0 ? "pass" : "fail",
    detail:
      tasks === null
        ? "turbo.json missing, unparseable, or tasks is not a map"
        : missingTasks.length === 0
          ? `${Object.keys(tasks).length} tasks (${Object.keys(tasks).join(", ")})`
          : `tasks map is missing ${missingTasks.join(" and ")}`,
    ...(tasks !== null && missingTasks.length === 0
      ? {}
      : { fix: "Restore turbo.json with a v2 `tasks` map including at least `build` and `dev`." }),
  });

  // Per-scaffold adapter checks.
  for (const scaffold of manifest.scaffolds) {
    const adapter = ADAPTERS[scaffold.framework];
    if (adapter?.doctor === undefined) continue;
    checks.push(...(await adapter.doctor({ workspaceRoot, scaffold })));
  }

  return checks;
}

/** True when no check failed (warns are allowed — spec: exit 0 or 5). */
export function isHealthy(checks: readonly DoctorCheck[]): boolean {
  return checks.every((check) => check.status !== "fail");
}
