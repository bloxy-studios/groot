/**
 * Static reading of package.json scripts and entry sources — nothing here is
 * ever executed. Scripts are tokenized like a POSIX shell would split them
 * (quotes, `&&`/`||`/`;`/`|`/`&`, leading `NAME=value` assignments, wrappers
 * such as cross-env) to answer three questions:
 *
 * - entry: which file does the dev/start script run? (`bun --watch src/index.ts`,
 *   `bun run --hot src/index.ts`, `tsx watch src/server.ts`, `bun run dev:api` → …)
 * - ports: `--port N`, `-p N`, `PORT=N` in scripts; `.listen(N)`, `port: N`,
 *   `PORT ?? N`, `Number(process.env.PORT) || N` in the entry source. A port
 *   is the app's when the command declaring it runs the app: a command that
 *   runs a source file in a dev/start/serve-style script (where the entry
 *   comes from), or any other command in dev/start/serve and what they
 *   `bun run` — except a known tool's CLI (a database studio, storybook, an
 *   email preview, a test UI, a container). Every other port belongs to its
 *   tool, wherever it is started;
 * - runtime: does a script run a source file with bun, or with node/tsx?
 */
import { basename } from "node:path";

export interface Invocation {
  /** Program that runs ("bun", "node", "tsx", "next", …) — bunx/npx are unwrapped. */
  readonly runner: string;
  /** Flags given to bunx/npx before the tool (e.g. --bun). */
  readonly launcherFlags: readonly string[];
  readonly args: readonly string[];
  /** Port from a leading PORT=N assignment. */
  readonly envPort: number | null;
}

export interface EntryCandidate {
  readonly file: string;
  readonly script: string;
  readonly runner: string;
}

export interface ScriptPort {
  readonly port: number;
  readonly script: string;
  /** Declared by a command that runs the app itself — not by a tool's. */
  readonly app: boolean;
  /** Source files the declaring command runs, directly or through `bun run <script>`. */
  readonly runs: readonly string[];
}

export interface RuntimeSignals {
  /** Some script runs a source file with bun. */
  readonly bunFile: boolean;
  /** Some script runs a source file with node, tsx, ts-node, or nodemon. */
  readonly nodeFile: boolean;
  /** Some script opts a node-shebang tool into Bun (`bun --bun`, `bunx --bun`). */
  readonly bunFlag: boolean;
}

const WRAPPERS = new Set(["cross-env", "env", "nohup", "time", "exec"]);
const LAUNCHERS = new Set(["bunx", "npx", "pnpx"]);
const NODE_RUNNERS = new Set(["node", "tsx", "ts-node", "ts-node-dev", "nodemon"]);
const FILE_RUNNERS = new Set(["bun", ...NODE_RUNNERS, "deno"]);
/** First positional words that are subcommands, not targets. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  bun: ["run"],
  tsx: ["watch"],
  deno: ["run"],
};
/** Flags whose value is the next token (when not written as --flag=value). */
const VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--preload",
  "--conditions",
  "-C",
  "--cwd",
  "--config",
  "-c",
  "--tsconfig",
  "--tsconfig-override",
  "--port",
  "--inspect-port",
  "--watch-path",
  "-P",
  "--project",
]);
const NODEMON_VALUE_FLAGS = new Set(["-w", "--watch", "-e", "--ext", "-x", "--exec", "-i"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** The scripts that run the app itself. */
const ENTRY_SCRIPTS = ["dev", "start", "serve"];
const MAX_SCRIPT_DEPTH = 3;
/**
 * CLIs that start a tool beside the app — a database studio, a component
 * workshop, an email preview, a test UI, a container, a mock server. The port
 * such a command declares is the tool's, never the app's, even when the app's
 * own dev script starts it.
 */
const TOOL_CLIS: ReadonlySet<string> = new Set([
  "drizzle-kit",
  "prisma",
  "storybook",
  "start-storybook",
  "ladle",
  "histoire",
  "email",
  "react-email",
  "jsx-email",
  "maildev",
  "mailpit",
  "mailhog",
  "vitest",
  "jest",
  "playwright",
  "cypress",
  "docker",
  "docker-compose",
  "podman",
  "json-server",
  "prism",
  "inngest-cli",
  "firebase",
  "supabase",
  "webpack-bundle-analyzer",
]);

export function toPort(text: string | undefined): number | null {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Split a script into simple commands of tokens (quotes honored, operators split). */
export function tokenizeScript(script: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: string | null = null;
  const endToken = (): void => {
    if (hasToken) current.push(token);
    token = "";
    hasToken = false;
  };
  const endCommand = (): void => {
    endToken();
    if (current.length > 0) commands.push(current);
    current = [];
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      endToken();
    } else if (";|&()".includes(ch)) {
      endCommand();
    } else {
      token += ch;
      hasToken = true;
    }
  }
  endCommand();
  return commands;
}

/** Interpret one tokenized command: strip env assignments and wrappers, unwrap bunx/npx. */
export function parseCommand(tokens: readonly string[]): Invocation | null {
  let index = 0;
  let envPort: number | null = null;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (assignment !== null) {
      if (assignment[1] === "PORT") envPort = toPort(assignment[2]);
    } else if (!WRAPPERS.has(token) && token !== "--") {
      break;
    }
    index++;
  }
  const first = tokens[index];
  if (first === undefined) return null;
  let runner = basename(first);
  index++;
  const launcherFlags: string[] = [];
  const bunX = runner === "bun" && tokens[index] === "x"; // `bun x <tool>` is bunx
  if (LAUNCHERS.has(runner) || bunX) {
    if (bunX) index++;
    while ((tokens[index] ?? "").startsWith("-")) launcherFlags.push(tokens[index++] as string);
    const tool = tokens[index];
    if (tool === undefined) return null;
    // "tsx@4.19.2" → "tsx"; scoped tools keep their scope.
    runner = basename(tool).replace(/(.)@[^@/]*$/, "$1");
    index++;
  }
  return { runner, launcherFlags, args: tokens.slice(index), envPort };
}

/** First positional argument of a file runner (`bun run --hot src/index.ts` → src/index.ts). */
export function runTarget(invocation: Invocation): string | null {
  if (!FILE_RUNNERS.has(invocation.runner)) return null;
  const subcommands = SUBCOMMANDS[invocation.runner] ?? [];
  const valueFlags = invocation.runner === "nodemon" ? NODEMON_VALUE_FLAGS : VALUE_FLAGS;
  let skippedSubcommand = false;
  const { args } = invocation;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && valueFlags.has(arg)) i++;
      continue;
    }
    if (!skippedSubcommand && subcommands.includes(arg)) {
      skippedSubcommand = true;
      continue;
    }
    return arg;
  }
  return null;
}

/** A project-relative source path a script names, or null (absolute/escaping paths are refused). */
export function normalizeSourcePath(target: string): string | null {
  const path = target.replace(/^(?:\.\/)+/, "");
  if (!SOURCE_FILE.test(path) || path.startsWith("/") || path.includes("\\")) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return path;
}

type Scripts = Readonly<Record<string, string>>;

/** `first` (those present), then the `<name>:…`/`<name>-…` variants of them by name. */
function scriptsInOrder(scripts: Scripts, first: readonly string[]): string[] {
  const named = first.filter((name) => Object.hasOwn(scripts, name));
  const prefixed = Object.keys(scripts)
    .filter(
      (name) => !named.includes(name) && first.some((p) => new RegExp(`^${p}[:-]`).test(name)),
    )
    .sort();
  return [...named, ...prefixed];
}

function invocations(script: string): Invocation[] {
  return tokenizeScript(script)
    .map(parseCommand)
    .filter((entry): entry is Invocation => entry !== null);
}

/** The script a command runs with `bun run <script>` (or `bun <script>`), or null. */
function scriptTarget(scripts: Scripts, invocation: Invocation): string | null {
  if (invocation.runner !== "bun") return null;
  const target = runTarget(invocation);
  if (target === null || normalizeSourcePath(target) !== null) return null;
  return Object.hasOwn(scripts, target) ? target : null;
}

/** Files the dev/start/serve scripts run, in priority order (follows `bun run <script>`). */
export function entryCandidates(scripts: Scripts): EntryCandidate[] {
  const found: EntryCandidate[] = [];
  const visit = (name: string, origin: string, depth: number): void => {
    for (const invocation of invocations(scripts[name] ?? "")) {
      const target = runTarget(invocation);
      const file = target === null ? null : normalizeSourcePath(target);
      if (file !== null) {
        found.push({ file, script: origin, runner: invocation.runner });
        continue;
      }
      const script = scriptTarget(scripts, invocation);
      if (script !== null && depth < MAX_SCRIPT_DEPTH) visit(script, origin, depth + 1);
    }
  };
  for (const name of scriptsInOrder(scripts, ENTRY_SCRIPTS)) visit(name, name, 0);
  return found;
}

function flagPort(args: readonly string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const inline = /^(?:--port|-p)=(\d+)$/.exec(arg);
    if (inline !== null) return toPort(inline[1]);
    if (arg === "--port" || arg === "-p") {
      const port = toPort(args[i + 1]);
      if (port !== null) return port;
    }
  }
  return null;
}

/** `names` (those present) and every script they run with `bun run <script>`, in visit order. */
function reachableScripts(scripts: Scripts, names: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (name: string, depth: number): void => {
    if (found.includes(name) || !Object.hasOwn(scripts, name)) return;
    found.push(name);
    if (depth >= MAX_SCRIPT_DEPTH) return;
    for (const invocation of invocations(scripts[name] ?? "")) {
      const script = scriptTarget(scripts, invocation);
      if (script !== null) visit(script, depth + 1);
    }
  };
  for (const name of names) visit(name, 0);
  return found;
}

/** Source files a command runs: its own target file, or what the script it `bun run`s runs. */
function filesRun(scripts: Scripts, invocation: Invocation, depth = 0): string[] {
  const target = runTarget(invocation);
  const file = target === null ? null : normalizeSourcePath(target);
  if (file !== null) return [file];
  const script = scriptTarget(scripts, invocation);
  if (script === null || depth >= MAX_SCRIPT_DEPTH) return [];
  return invocations(scripts[script] ?? "").flatMap((next) => filesRun(scripts, next, depth + 1));
}

/** Does the command start only tools — a tool's CLI, or `bun run` of a script starting nothing else? */
function startsOnlyTools(scripts: Scripts, invocation: Invocation, depth = 0): boolean {
  if (TOOL_CLIS.has(invocation.runner)) return true;
  const script = scriptTarget(scripts, invocation);
  if (script === null || depth >= MAX_SCRIPT_DEPTH) return false;
  const commands = invocations(scripts[script] ?? "");
  return commands.length > 0 && commands.every((next) => startsOnlyTools(scripts, next, depth + 1));
}

/**
 * Ports declared in scripts (first owner wins), the app's scripts first:
 * dev/start/serve and what they `bun run`, then their `dev:*`-style variants,
 * then every other script by name. A port is the app's (`app`) when its
 * command runs the app: one running a source file anywhere the entry may
 * come from, or any other command in dev/start/serve and what they `bun run`
 * — never a tool's CLI. `dev:*` scripts often start a tool (`dev:email`,
 * `dev:db`), so there only a command running a source file counts.
 */
export function scriptPorts(scripts: Scripts): ScriptPort[] {
  const main = reachableScripts(scripts, ENTRY_SCRIPTS);
  const entry = reachableScripts(scripts, scriptsInOrder(scripts, ENTRY_SCRIPTS));
  const others = Object.keys(scripts)
    .filter((name) => !entry.includes(name))
    .sort();
  const ports: ScriptPort[] = [];
  for (const script of [...entry, ...others]) {
    for (const invocation of invocations(scripts[script] ?? "")) {
      const runs = filesRun(scripts, invocation);
      const app =
        !startsOnlyTools(scripts, invocation) && (runs.length > 0 ? entry : main).includes(script);
      for (const port of [invocation.envPort, flagPort(invocation.args)]) {
        if (port !== null && !ports.some((known) => known.port === port)) {
          ports.push({ port, script, app, runs });
        }
      }
    }
  }
  return ports;
}

/** Which runtimes the scripts invoke on source files. */
export function runtimeSignals(scripts: Readonly<Record<string, string>>): RuntimeSignals {
  let bunFile = false;
  let nodeFile = false;
  let bunFlag = false;
  for (const script of Object.values(scripts)) {
    for (const invocation of invocations(script)) {
      if (invocation.launcherFlags.includes("--bun") || invocation.args.includes("--bun")) {
        bunFlag = true;
      }
      const target = runTarget(invocation);
      if (target === null || normalizeSourcePath(target) === null) continue;
      if (invocation.runner === "bun") bunFile = true;
      else if (NODE_RUNNERS.has(invocation.runner)) nodeFile = true;
    }
  }
  return { bunFile, nodeFile, bunFlag };
}

/** Ordered most-specific first, so a server port outranks e.g. a database `port:` option. */
const SOURCE_PORT_PATTERNS: readonly RegExp[] = [
  /\.listen\(\s*(\d{2,5})\b/g,
  /\bPORT\s*\?\?\s*["']?(\d{2,5})\b/g,
  /\bPORT\)?\s*\|\|\s*["']?(\d{2,5})\b/g,
  /\b(?:const|let|var)\s+(?:PORT|port)\s*=\s*(\d{2,5})\b/g,
  /\bport\s*:\s*(\d{2,5})\b/g,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Literal ports in an entry source (deduplicated, most specific pattern first). */
export function sourcePorts(source: string): number[] {
  const text = stripComments(source);
  const ports: number[] = [];
  for (const pattern of SOURCE_PORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const port = toPort(match[1]);
      if (port !== null && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

const SERVER_PATTERNS: readonly RegExp[] = [
  /\bBun\.serve\s*\(/,
  /\bDeno\.serve\s*\(/,
  /\.listen\s*\(/,
  /\bcreateServer\s*\(/,
  /export\s+default\s*\{[^}]*\bfetch\b/,
];

/** Does an entry source start a server? (kind inference for framework-less units) */
export function startsServer(source: string): boolean {
  const text = stripComments(source);
  return SERVER_PATTERNS.some((pattern) => pattern.test(text));
}
