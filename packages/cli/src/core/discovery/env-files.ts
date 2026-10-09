/**
 * Environment files: discovery reports which `.env*` files a unit has and
 * the variable NAMES they assign — never values. The parser keeps only the
 * name capture of each assignment; values are skipped, so nothing secret can
 * reach an observation, a plan, or agent context through discovery.
 *
 * Lines inside a value are never mistaken for assignments: a quoted value
 * spanning lines is skipped through its closing quote (whatever its key looks
 * like), an armored block (`-----BEGIN …` through `-----END …`, e.g. a PEM key
 * pasted without quotes) is skipped whole, and a line whose "value" starts
 * with another `=` (a base64 padding tail such as `kQ29uZg==`) is not an
 * assignment.
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
/** A dotenv assignment line; dotenv also accepts `.` and `-` in keys. */
const ASSIGNMENT = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;
/** The only keys reported as variable names. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARMOR_BEGIN = "-----BEGIN ";
const ARMOR_END = "-----END ";
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

/** Does unquoted text (inline ` # comment` ignored) open an armored block it does not close? */
function opensArmor(text: string): boolean {
  const code = text.replace(/(?:^|\s)#.*$/, "");
  const begin = code.lastIndexOf(ARMOR_BEGIN);
  return begin !== -1 && !code.includes(ARMOR_END, begin);
}

/** Variable names assigned in dotenv text, in first-appearance order. */
export function envNames(text: string): string[] {
  const names: string[] = [];
  let pendingQuote: string | null = null;
  let inArmor = false;
  for (const line of text.split(/\r?\n/)) {
    if (pendingQuote !== null) {
      if (closesQuote(line, pendingQuote)) pendingQuote = null;
      continue;
    }
    if (inArmor) {
      if (line.includes(ARMOR_END)) inArmor = opensArmor(line); // a chained block may open here
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (match === null) {
      inArmor = opensArmor(line);
      continue;
    }
    const name = match[1] as string;
    const value = match[2] as string;
    pendingQuote = openQuote(value);
    // A quoted value is self-contained (or tracked above); only bare text opens a block.
    if (!/^["'`]/.test(value)) inArmor = opensArmor(value);
    if (!IDENTIFIER.test(name) || value.startsWith("=")) continue;
    if (!names.includes(name)) names.push(name);
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
