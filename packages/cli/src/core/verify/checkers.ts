/**
 * Built-in checkers. Structural checks are fast, offline, and side-effect
 * free (doctor-grade). Build checks run the project's own scripts or local
 * compiler — never a network-fetched tool — and say `skipped` with the reason
 * when a unit has nothing to run. Runtime and product-flow checkers are
 * registered by the recipes that know how to drive them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationContract } from "../contracts/common.ts";
import { envContractViolations, isGitIgnored, missingRequiredEnv } from "../env.ts";
import { hashFile } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { portCollisions } from "../ports.ts";
import { runProcess, tail } from "../process.ts";
import { findRegions } from "../transforms/regions.ts";
import { type CheckInput, type CheckOutcome, registerChecker } from "./engine.ts";

const STATIC = (tool: string) => ({ kind: "static" as const, tool, command: null });

function readPackage(root: string, unit: string): Record<string, unknown> | null {
  try {
    const path = resolveInProject(root, unit === "." ? "package.json" : `${unit}/package.json`);
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function blueprintCheck({ root, blueprint }: CheckInput): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const app of blueprint.apps) {
    if (!existsSync(resolveInProject(root, app.path === "." ? "package.json" : app.path))) {
      problems.push(`${app.id}: ${app.path} is missing`);
    }
  }
  for (const [port, paths] of portCollisions(blueprint)) {
    problems.push(`dev port ${port} is declared by ${paths.join(" and ")}`);
  }
  return problems.length === 0
    ? {
        status: "pass",
        summary: `groot.json is valid; ${blueprint.apps.length} app(s) present, no port collisions`,
        method: STATIC("structural.blueprint"),
      }
    : {
        status: "fail",
        summary: problems.join("; "),
        method: STATIC("structural.blueprint"),
        nextStep:
          "Restore the missing app or update groot.json (a plan is the safe way to change it).",
        details: { problems },
      };
}

async function packageCheck({ root, contract }: CheckInput): Promise<CheckOutcome> {
  const unit = contract.unit ?? ".";
  const pkg = readPackage(root, unit);
  if (pkg === null) {
    return {
      status: "fail",
      summary: `${unit}/package.json is missing or unparseable`,
      method: STATIC("structural.package"),
      nextStep: `Restore ${unit}/package.json.`,
    };
  }
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    return {
      status: "fail",
      summary: `${unit}/package.json has no name`,
      method: STATIC("structural.package"),
    };
  }
  return {
    status: "pass",
    summary: `${unit} is package "${pkg.name}"`,
    method: STATIC("structural.package"),
  };
}

async function envCheck({ root, blueprint }: CheckInput): Promise<CheckOutcome> {
  const unsound = envContractViolations(blueprint.environment);
  if (unsound.length > 0) {
    return { status: "fail", summary: unsound.join("; "), method: STATIC("structural.env") };
  }
  const exposed: string[] = [];
  for (const contract of blueprint.environment.filter((entry) => entry.sensitivity === "secret")) {
    if ((await isGitIgnored(root, contract.storage)) === false)
      exposed.push(`${contract.name} → ${contract.storage}`);
  }
  if (exposed.length > 0) {
    return {
      status: "fail",
      summary: `secret storage is not gitignored: ${exposed.join(", ")}`,
      method: STATIC("structural.env"),
      nextStep: "Add the storage file to .gitignore before putting secrets in it.",
    };
  }
  const missing = missingRequiredEnv(root, blueprint.environment);
  if (missing.length > 0) {
    return {
      status: "blocked",
      summary: `required variables not set: ${missing.map((entry) => `${entry.name} (${entry.storage})`).join(", ")}`,
      method: STATIC("structural.env"),
      reason: "missing configuration",
      nextStep: missing
        .map((entry) =>
          entry.generate === "random-secret"
            ? `set ${entry.name} in ${entry.storage}, or re-apply the plan that declared it (Groot generates local secrets)`
            : `set ${entry.name} in ${entry.storage} (${entry.description})`,
        )
        .join("; "),
      details: { missing: missing.map((entry) => entry.name) },
    };
  }
  return {
    status: "pass",
    summary: `${blueprint.environment.length} environment contract(s) satisfied (names checked; values never read)`,
    method: STATIC("structural.env"),
  };
}

async function ownershipCheck({ root, lock }: CheckInput): Promise<CheckOutcome> {
  const artifacts = [
    ...(lock?.recipes.flatMap((recipe) => recipe.artifacts) ?? []),
    ...(lock?.context ?? []),
  ];
  const missing: string[] = [];
  const modified: string[] = [];
  for (const artifact of artifacts) {
    const absolute = resolveInProject(root, artifact.path);
    const hash = await hashFile(absolute);
    if (hash === null) {
      missing.push(artifact.path);
      continue;
    }
    if (artifact.ownership === "region") {
      const regions = findRegions(readFileSync(absolute, "utf8"), artifact.path);
      for (const part of artifact.parts) {
        const region = regions.find((entry) => entry.id === part);
        if (region === undefined) missing.push(`${artifact.path}#${part}`);
        else if (!region.intact) modified.push(`${artifact.path}#${part}`);
      }
    } else if (hash !== artifact.sha256) {
      modified.push(artifact.path);
    }
  }
  if (missing.length > 0) {
    return {
      status: "fail",
      summary: `Groot-owned artifacts missing: ${missing.join(", ")}`,
      method: STATIC("structural.ownership"),
      nextStep: "Restore them (git checkout) or re-run the capability plan.",
      details: { missing, modified },
    };
  }
  return {
    status: "pass",
    summary:
      modified.length === 0
        ? `${artifacts.length} Groot-owned artifact(s) unchanged`
        : `${artifacts.length} owned artifact(s) present; edited by hand since Groot wrote them: ${modified.join(", ")}`,
    method: STATIC("structural.ownership"),
    details: { modified },
    limitations:
      modified.length > 0
        ? ["hand-edited owned files are preserved; Groot will not overwrite them"]
        : [],
  };
}

/** Run a unit's script (or local compiler) as a build check. */
async function scriptCheck(
  input: CheckInput,
  pick: (pkg: Record<string, unknown>, unitDir: string) => string[] | null,
  label: string,
): Promise<CheckOutcome> {
  const unit = input.contract.unit ?? ".";
  const pkg = readPackage(input.root, unit);
  const cwd = unit === "." ? input.root : resolveInProject(input.root, unit);
  const argv = pkg === null ? null : pick(pkg, cwd);
  if (argv === null) {
    return {
      status: "skipped",
      summary: `${unit} has nothing to run for ${label}`,
      method: STATIC(`build.${label}`),
      reason: `no ${label} script or local compiler in ${unit}`,
    };
  }
  const result = await runProcess({
    argv,
    cwd,
    // The context's environment: a task's pre-review checks pass a
    // credential-free one, so unreviewed scripts never see credentials.
    env: { ...input.ctx.env, CI: "1" },
    timeoutMs: 600_000,
    signal: input.ctx.signal,
  });
  const log = `${result.stdout}\n${result.stderr}`;
  const ok = result.exitCode === 0;
  return {
    status: result.aborted ? "skipped" : ok ? "pass" : "fail",
    summary: result.aborted
      ? `${label} cancelled`
      : ok
        ? `${argv.join(" ")} succeeded in ${unit} (${result.durationMs} ms)`
        : `${argv.join(" ")} failed in ${unit} (exit ${result.exitCode ?? result.signal}): ${tail(log, 3)}`,
    method: {
      kind: "command",
      tool: `build.${label}`,
      command: { argv, cwd: unit, exitCode: result.exitCode },
    },
    artifacts: [{ name: `${label}.log`, kind: "log", content: log }],
    reason: result.aborted ? "cancelled" : null,
  };
}

const typecheck = (input: CheckInput): Promise<CheckOutcome> =>
  scriptCheck(
    input,
    (pkg, cwd) => {
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      if (typeof scripts.typecheck === "string") return ["bun", "run", "typecheck"];
      if (typeof scripts["check-types"] === "string") return ["bun", "run", "check-types"];
      const local = join(cwd, "node_modules", ".bin", "tsc");
      return existsSync(join(cwd, "tsconfig.json")) && existsSync(local)
        ? [local, "--noEmit"]
        : null;
    },
    "typecheck",
  );

const build = (input: CheckInput): Promise<CheckOutcome> =>
  scriptCheck(
    input,
    (pkg) =>
      typeof ((pkg.scripts ?? {}) as Record<string, string>).build === "string"
        ? ["bun", "run", "build"]
        : null,
    "build",
  );

export function registerBuiltInCheckers(): void {
  registerChecker("structural.blueprint", blueprintCheck);
  registerChecker("structural.package", packageCheck);
  registerChecker("structural.env", envCheck);
  registerChecker("structural.ownership", ownershipCheck);
  registerChecker("build.typecheck", typecheck);
  registerChecker("build.script", build);
}

const NO_NEEDS = { network: false, processes: false, credentials: [], toolchains: [] };

/** Default contracts every registered project gets in addition to its declared ones. */
export function defaultContracts(blueprint: CheckInput["blueprint"]): VerificationContract[] {
  const contracts: VerificationContract[] = [
    {
      id: "structural.blueprint",
      profile: "structural",
      description: "groot.json is valid and its apps exist",
      checker: "structural.blueprint",
      capability: null,
      unit: null,
      needs: NO_NEEDS,
    },
    {
      id: "structural.env",
      profile: "structural",
      description: "environment contracts are sound and satisfied (names only)",
      checker: "structural.env",
      capability: null,
      unit: null,
      needs: NO_NEEDS,
    },
    {
      id: "structural.ownership",
      profile: "structural",
      description: "Groot-owned artifacts are present (hand edits reported, never overwritten)",
      checker: "structural.ownership",
      capability: null,
      unit: null,
      needs: NO_NEEDS,
    },
  ];
  for (const app of blueprint.apps) {
    contracts.push(
      {
        id: `structural.package.${app.id}`,
        profile: "structural",
        description: `${app.path} is a named package`,
        checker: "structural.package",
        capability: null,
        unit: app.path,
        needs: NO_NEEDS,
      },
      {
        id: `build.typecheck.${app.id}`,
        profile: "build",
        description: `${app.path} typechecks`,
        checker: "build.typecheck",
        capability: null,
        unit: app.path,
        needs: { ...NO_NEEDS, processes: true },
      },
      {
        id: `build.script.${app.id}`,
        profile: "build",
        description: `${app.path} builds`,
        checker: "build.script",
        capability: null,
        unit: app.path,
        needs: { ...NO_NEEDS, processes: true },
      },
    );
  }
  return contracts;
}
