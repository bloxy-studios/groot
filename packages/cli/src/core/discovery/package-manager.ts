/**
 * Package-manager detection from the root `packageManager` field and the
 * lockfiles present. Disagreement is reported, never resolved silently:
 * `packageManager: "pnpm@9"` next to `bun.lock` is a contradiction (and the
 * fact drops to low confidence), as are lockfiles of several managers. Files
 * that only *suggest* a manager (pnpm-workspace.yaml, .yarnrc.yml, .pnp.cjs)
 * are returned as conflicting signals when they disagree with the result, so
 * support assessment can tell "no lockfile yet" from "managed by something else".
 */
import type { PackageManager, Sha256 } from "../contracts/common.ts";
import type { ContradictionNote, FactFactory, ObservedFact } from "./facts.ts";
import type { ProjectFs } from "./fs.ts";

type Manager = Exclude<PackageManager, "unknown">;

const LOCKFILES: ReadonlyArray<readonly [string, Manager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

const MANAGER_HINTS: ReadonlyArray<readonly [string, Manager]> = [
  ["pnpm-workspace.yaml", "pnpm"],
  [".yarnrc.yml", "yarn"],
  [".pnp.cjs", "yarn"],
];

const MANAGERS: readonly string[] = ["bun", "npm", "pnpm", "yarn"];

export interface RootManifest {
  readonly value: Readonly<Record<string, unknown>>;
  readonly sha256: Sha256;
}

export interface PackageManagerFindings {
  readonly fact: ObservedFact<PackageManager>;
  readonly lockfiles: readonly string[];
  /** Human-readable signals of another manager than the resolved one. */
  readonly conflictingSignals: readonly string[];
  readonly contradictions: readonly ContradictionNote[];
}

/** "pnpm@9.1.0+sha512.…" → "pnpm"; null when absent or malformed. */
export function declaredManagerName(field: unknown): string | null {
  if (typeof field !== "string") return null;
  return /^([a-z][a-z0-9-]*)@/.exec(field)?.[1] ?? null;
}

function managerOf(file: string): Manager {
  return (LOCKFILES.find(([name]) => name === file) as readonly [string, Manager])[1];
}

function listing(files: readonly string[]): string {
  return `${files.join(", ")} ${files.length === 1 ? "is" : "are"} present`;
}

export async function detectPackageManager(
  fs: ProjectFs,
  rootManifest: RootManifest | null,
  fact: FactFactory,
): Promise<PackageManagerFindings> {
  const lockfiles: string[] = [];
  for (const [file] of LOCKFILES) if (await fs.isFile(file)) lockfiles.push(file);
  const lockManagers = [...new Set(lockfiles.map(managerOf))];
  const declaredName = declaredManagerName(rootManifest?.value.packageManager);
  const declared = declaredName !== null && MANAGERS.includes(declaredName) ? declaredName : null;
  const contradictions: ContradictionNote[] = [];
  const conflictingSignals: string[] = [];
  if (declaredName !== null && declared === null) {
    conflictingSignals.push(`package.json packageManager names ${declaredName}`);
  }

  let result: ObservedFact<PackageManager>;
  if (declared !== null) {
    const stale = lockfiles.filter((file) => managerOf(file) !== declared);
    const matching = lockfiles.find((file) => managerOf(file) === declared);
    if (stale.length > 0) {
      contradictions.push({
        topic: "packageManager",
        explanation: `package.json declares packageManager ${declared} but ${listing(stale)}`,
        sources: ["package.json", ...stale],
      });
    }
    result = fact({
      value: declared as Manager,
      source:
        matching === undefined
          ? "package.json#packageManager"
          : `package.json#packageManager + ${matching}`,
      method: "manifest",
      confidence: stale.length > 0 ? "low" : matching === undefined ? "high" : "certain",
      fingerprint: rootManifest?.sha256 ?? null,
    });
  } else if (lockManagers.length === 1) {
    result = fact({
      value: lockManagers[0] as Manager,
      source: lockfiles.join(", "),
      method: "lockfile",
      confidence: "high",
      fingerprint: await fs.hash(lockfiles[0] as string),
    });
  } else if (lockManagers.length > 1) {
    contradictions.push({
      topic: "packageManager",
      explanation: `lockfiles of several package managers are present: ${lockfiles.join(", ")}`,
      sources: lockfiles,
    });
    result = fact({
      value: "unknown",
      source: lockfiles.join(", "),
      method: "lockfile",
      confidence: "low",
    });
  } else {
    result = fact({
      value: "unknown",
      source: "no packageManager field or lockfile",
      method: "default",
      confidence: "low",
    });
  }

  for (const [file, manager] of MANAGER_HINTS) {
    if (manager === result.value || !(await fs.isFile(file))) continue;
    conflictingSignals.push(`${file} suggests ${manager}`);
    if (result.value !== "unknown") {
      contradictions.push({
        topic: "packageManager",
        explanation: `${file} (a ${manager} file) is present in a ${result.value} project`,
        sources: [file, result.source],
      });
    }
  }
  return { fact: result, lockfiles, conflictingSignals, contradictions };
}
