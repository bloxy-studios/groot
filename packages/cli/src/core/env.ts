/**
 * Environment-contract enforcement. Contracts carry names, scopes, and the
 * file the consuming framework actually loads — never values. These checks
 * run at planning time (a recipe cannot declare a secret with a public prefix
 * or store it in a committed file) and at verification time (required
 * variables present by NAME in their storage file).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
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

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
};

/** A path git C-quoted (`"apps/say \"hi\""`, octal bytes like `\303\274`), decoded. */
function unquoteGitPath(quoted: string): string {
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1, index + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const escaped = body[index + 1] ?? "";
    bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The rule source and pattern of a `check-ignore --verbose` line
 * (`<source>:<line>:<pattern><TAB><path>`), or null when unreadable. Even
 * with core.quotePath off, git C-quotes a source holding a quote, a
 * backslash, or a control character.
 */
function verboseRule(line: string): { source: string; pattern: string } | null {
  if (line.startsWith('"')) {
    let end = 1;
    while (end < line.length && line[end] !== '"') end += line[end] === "\\" ? 2 : 1;
    if (end >= line.length) return null;
    const rest = /^:\d+:(.*)\t/.exec(line.slice(end + 1));
    return rest === null
      ? null
      : { source: unquoteGitPath(line.slice(0, end + 1)), pattern: rest[1] ?? "" };
  }
  const match = /^(.*?):\d+:(.*)\t/.exec(line);
  return match === null ? null : { source: match[1] ?? "", pattern: match[2] ?? "" };
}

/**
 * Is `path` ignored by the repository's own .gitignore files? The deciding
 * rule must come from a .gitignore inside the repository: git reports
 * core.excludesFile by absolute path (whatever its name) and
 * .git/info/exclude by name, and neither travels with a clone — a teammate
 * could still commit the file. A negated rule (`!x`) decides "not ignored"
 * even though --verbose exits 0. Non-ASCII paths are read unquoted
 * (core.quotePath=false) and any path git still quotes is decoded; output
 * that can't be read counts as not ignored. A tracked file is never ignored
 * (see trackedByRepository). null = not a git repository.
 */
export async function ignoredByRepository(root: string, path: string): Promise<boolean | null> {
  const result = await git(root, [
    "-c",
    "core.quotePath=false",
    "check-ignore",
    "--verbose",
    "--",
    path,
  ]);
  if (result.exitCode === 1) return false;
  if (result.exitCode !== 0) return null;
  const rule = verboseRule(result.stdout);
  if (rule === null) return false;
  const repositoryFile =
    !isAbsolute(rule.source) &&
    !rule.source.startsWith("/") &&
    posix.basename(rule.source) === ".gitignore";
  return repositoryFile && !rule.pattern.startsWith("!");
}

/**
 * Is `path` tracked by git (committed or staged)? .gitignore does not apply to
 * a tracked file — it stays in every clone until removed from the index.
 * The path is matched literally, never as a glob. null = not a git repository.
 */
export async function trackedByRepository(root: string, path: string): Promise<boolean | null> {
  const result = await git(root, [
    "--literal-pathspecs",
    "ls-files",
    "--error-unmatch",
    "--",
    path,
  ]);
  if (result.exitCode === 0) return true;
  return result.exitCode === 1 ? false : null;
}

/** What a dotenv file in the project sets (name → loaded value); empty when unreadable. */
function storedValues(root: string, relPath: string): Map<string, string> {
  try {
    return dotenvValues(readFileSync(resolveInProject(root, relPath), "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Names a dotenv file sets, read the way Bun loads it: an assignment whose
 * loaded value is blank (`NAME=`, `NAME= # note`, `NAME=""`) leaves the
 * variable unset for the app, so it does not count. Values are never returned.
 */
export function envNamesIn(root: string, relPath: string): Set<string> {
  return new Set(
    [...storedValues(root, relPath)]
      .filter(([, value]) => value.trim() !== "")
      .map(([name]) => name),
  );
}

/**
 * The current values of the secret contracts — set in the environment or in
 * their storage files — for redaction only: callers mask them out of what
 * they store and never return or print them.
 */
export function secretValues(
  root: string,
  contracts: readonly EnvVarContract[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const values = new Set<string>();
  for (const contract of contracts) {
    if (contract.sensitivity !== "secret") continue;
    const stored = storedValues(root, contract.storage).get(contract.name);
    for (const value of [env[contract.name], stored]) {
      if (value !== undefined && value.trim() !== "") values.add(value);
    }
  }
  return [...values];
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
