/**
 * Writable-support assessment. Groot certifies writes only where it has
 * evidence they are safe: a Bun-managed project (or one with no lockfile and
 * no other manager's files yet), single-app or apps/packages monorepo
 * topology, every unit a TypeScript/JavaScript package running on bun or
 * node. Everything else stays fully inspectable but `inspect-only`, with
 * precise reasons and one actionable next step; a path that isn't a project
 * directory at all is `unsupported`.
 */
import type { PackageManager } from "../contracts/common.ts";
import type { ProjectUnit } from "../contracts/project.ts";
import type { NativeMarker } from "./native.ts";

export interface SupportInput {
  readonly packageManager: PackageManager;
  /** Contradiction explanations about the package manager. */
  readonly packageManagerConflicts: readonly string[];
  /** Files/fields signalling another manager (pnpm-workspace.yaml, …). */
  readonly conflictingSignals: readonly string[];
  readonly lockfiles: readonly string[];
  readonly topology: "single" | "monorepo" | "unknown";
  readonly units: readonly ProjectUnit[];
  readonly unitProblems: readonly string[];
  readonly nativeMarkers: readonly NativeMarker[];
}

export interface Support {
  level: "certified" | "inspect-only" | "unsupported";
  reasons: string[];
  nextStep: string | null;
}

const RECHECK = "then run groot inspect again";

export function notADirectory(target: string, exists: boolean): Support {
  return {
    level: "unsupported",
    reasons: [exists ? `${target} is not a directory` : `${target} does not exist`],
    nextStep:
      "Point groot at a project directory: groot inspect <dir> (no walk-up — the directory is the project root).",
  };
}

function topologyReason(input: SupportInput): { reason: string; next: string } | null {
  if (input.topology !== "unknown") return null;
  if (input.nativeMarkers.length > 0) {
    const kinds = input.nativeMarkers
      .map((marker) => `${marker.label} (${marker.file})`)
      .join(", ");
    return {
      reason: `native-only project: ${kinds} — Groot certifies writes to Bun/TypeScript projects only`,
      next: "Groot reports facts for this project but will not write to it. A Bun/TypeScript app with a package.json (for example under apps/) can be adopted.",
    };
  }
  return {
    reason: "no package.json at the project root — topology unknown",
    next: `Create a Bun project here (bun init, or groot init <dir> for a new monorepo), ${RECHECK}.`,
  };
}

function packageManagerReason(input: SupportInput): { reason: string; next: string } | null {
  const pm = input.packageManager;
  if (input.packageManagerConflicts.length > 0) {
    return {
      reason: `package manager is ambiguous: ${input.packageManagerConflicts.join("; ")}`,
      next: `Make package.json "packageManager" and the lockfile agree (for Groot: "bun@<version>" with bun.lock; delete the stale lockfile), ${RECHECK}.`,
    };
  }
  if (pm === "npm" || pm === "pnpm" || pm === "yarn") {
    const lockfile =
      input.lockfiles.find((file) => !file.startsWith("bun.")) ?? `the ${pm} lockfile`;
    return {
      reason: `package manager is ${pm} — Groot certifies writes to Bun-managed projects only`,
      next: `Switch to Bun: run bun install (it migrates ${lockfile} to bun.lock), set "packageManager": "bun@<version>" in package.json, delete ${lockfile}, ${RECHECK}.`,
    };
  }
  if (pm === "unknown" && input.conflictingSignals.length > 0) {
    return {
      reason: `package manager is unclear: ${input.conflictingSignals.join("; ")}`,
      next: `Run bun install to create bun.lock and remove the other manager's files, ${RECHECK}.`,
    };
  }
  return null;
}

function unitReasons(input: SupportInput): string[] {
  const reasons = [...input.unitProblems];
  for (const unit of input.units) {
    if (unit.language === "unknown")
      reasons.push(`${unit.path} is not a TypeScript/JavaScript package`);
    const runtime = unit.runtime.value;
    if (runtime !== "bun" && runtime !== "node") {
      reasons.push(`${unit.path} runs on ${runtime}, not bun or node`);
    }
  }
  if (input.topology === "monorepo" && input.units.length === 0) {
    reasons.push("the workspace patterns match no package directories");
  }
  return reasons;
}

export function assessSupport(input: SupportInput): Support {
  const reasons: string[] = [];
  const next: string[] = [];
  for (const finding of [topologyReason(input), packageManagerReason(input)]) {
    if (finding === null) continue;
    reasons.push(finding.reason);
    next.push(finding.next);
  }
  const units = input.topology === "unknown" ? [] : unitReasons(input);
  reasons.push(...units);
  if (units.length > 0) {
    next.push(
      `Fix the listed packages (a valid package.json per workspace directory), ${RECHECK}.`,
    );
  }
  return reasons.length === 0
    ? { level: "certified", reasons: [], nextStep: null }
    : { level: "inspect-only", reasons, nextStep: next[0] ?? null };
}
