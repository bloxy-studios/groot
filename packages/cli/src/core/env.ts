/**
 * Environment-contract enforcement. Contracts carry names, scopes, and the
 * file the consuming framework actually loads — never values. These checks
 * run at planning time (a recipe cannot declare a secret with a public prefix
 * or store it in a committed file) and at verification time (required
 * variables present by NAME in their storage file).
 */
import { readFileSync } from "node:fs";
import { type EnvVarContract, PUBLIC_ENV_PREFIXES } from "./contracts/common.ts";
import { dotenvValues } from "./dotenv.ts";
import { GrootV2Error } from "./errors.ts";
import { resolveInProject } from "./fs/paths.ts";
import { git } from "./git.ts";

export function hasPublicPrefix(name: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Contract-level violations (empty = sound). */
export function envContractViolations(contracts: readonly EnvVarContract[]): string[] {
  const violations: string[] = [];
  for (const contract of contracts) {
    if (contract.sensitivity === "secret" && hasPublicPrefix(contract.name)) {
      violations.push(
        `${contract.name} is a secret but carries a client-exposure prefix — it would ship to browsers`,
      );
    }
    if (contract.sensitivity === "secret" && contract.scope === "public") {
      violations.push(`${contract.name} is a secret declared with public scope`);
    }
    if (contract.scope === "public" && !hasPublicPrefix(contract.name)) {
      violations.push(
        `${contract.name} is declared public but has no client-exposure prefix — the framework will not expose it`,
      );
    }
  }
  return violations;
}

/** Throw GROOT_E_INVALID_DOCUMENT when a recipe's contracts are unsound. */
export function assertEnvContracts(contracts: readonly EnvVarContract[]): void {
  const violations = envContractViolations(contracts);
  if (violations.length > 0) {
    throw new GrootV2Error(
      "GROOT_E_INVALID_DOCUMENT",
      `Unsafe environment contract: ${violations.join("; ")}`,
      {
        details: { violations },
      },
    );
  }
}

/** Is a project-relative path ignored by git? (null when not a git repository) */
export async function isGitIgnored(root: string, relPath: string): Promise<boolean | null> {
  const result = await git(root, ["check-ignore", "-q", "--", relPath]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

/**
 * Names a dotenv file sets, read the way Bun loads it: an assignment whose
 * loaded value is blank (`NAME=`, `NAME= # note`, `NAME=""`) leaves the
 * variable unset for the app, so it does not count. Values are never returned.
 */
export function envNamesIn(root: string, relPath: string): Set<string> {
  try {
    const text = readFileSync(resolveInProject(root, relPath), "utf8");
    return new Set(
      [...dotenvValues(text)].filter(([, value]) => value.trim() !== "").map(([name]) => name),
    );
  } catch {
    return new Set();
  }
}

/** Required variables missing (by name) from their storage files. */
export function missingRequiredEnv(
  root: string,
  contracts: readonly EnvVarContract[],
): EnvVarContract[] {
  return contracts.filter(
    (contract) => contract.required && !envNamesIn(root, contract.storage).has(contract.name),
  );
}
