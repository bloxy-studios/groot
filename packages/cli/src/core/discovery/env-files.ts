/**
 * Environment files: discovery reports which `.env*` files a unit has and
 * the variable NAMES they assign — never values. The parser keeps only the
 * name capture of each assignment; values are skipped (including multi-line
 * quoted values, whose continuation lines must not be mistaken for
 * assignments), so nothing secret can reach an observation, a plan, or
 * agent context through discovery.
 */
import { hasPublicPrefix } from "../env.ts";
import type { ProjectFs } from "./fs.ts";

export interface EnvVariable {
  name: string;
  file: string;
  publicPrefix: boolean;
}

export interface EnvFindings {
  readonly files: string[];
  readonly variables: EnvVariable[];
}

/** `.env` and `.env.<anything>` (not `.envrc`, a direnv shell script). */
const ENV_FILE = /^\.env(?:\..+)?$/;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const MAX_ENV_BYTES = 256 * 1024;

/** The quote a value opens without closing on the same line, if any. */
function openQuote(value: string): string | null {
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (value[i] === quote) return null;
  }
  return quote;
}

function closesQuote(line: string, quote: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (line[i] === quote) return true;
  }
  return false;
}

/** Variable names assigned in dotenv text, in first-appearance order. */
export function envNames(text: string): string[] {
  const names: string[] = [];
  let pendingQuote: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (pendingQuote !== null) {
      if (closesQuote(line, pendingQuote)) pendingQuote = null;
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (match === null) continue;
    const name = match[1] as string;
    if (!names.includes(name)) names.push(name);
    pendingQuote = openQuote(match[2] as string);
  }
  return names;
}

/** `.env*` files directly inside a unit directory and the names they assign. */
export async function envFindings(fs: ProjectFs, unitPath: string): Promise<EnvFindings> {
  const entries = await fs.list(unitPath);
  const files = entries
    .filter((entry) => entry.type === "file" && ENV_FILE.test(entry.name))
    .map((entry) => entry.path);
  const variables: EnvVariable[] = [];
  for (const file of files) {
    const content = await fs.readText(file, MAX_ENV_BYTES);
    if (content === null) continue;
    for (const name of envNames(content.text).sort()) {
      variables.push({ name, file, publicPrefix: hasPublicPrefix(name) });
    }
  }
  return { files, variables };
}
