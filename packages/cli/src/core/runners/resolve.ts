/**
 * Resolve the REAL agent executable. Terminal multiplexers put wrapper shims
 * first on PATH (cmux's `claude`/`codex` shims inject argv, MCP servers,
 * hooks, and env — and its Codex shim breaks codex 0.116 outright), so a
 * plain PATH lookup can silently change what runs. Resolution order:
 *
 * 1. GROOT_CLAUDE_PATH / GROOT_CODEX_PATH — honored exactly as given.
 * 2. PATH, skipping wrapper shims: a script under a `cmux-cli-shims` dir, or
 *    a script that execs a `*-wrapper`.
 * 3. Codex's npm/bun launcher (`@openai/codex/bin/codex.js`, a Node script
 *    that forwards signals to a native child) is replaced by the native
 *    vendor binary it would spawn, with the launcher's PATH prepend — killing
 *    the launcher alone can orphan the native process.
 *
 * Every skip is recorded as a note so discovery output explains the choice.
 */
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { RunnerId } from "../contracts/task.ts";

export interface ResolvedExecutable {
  /** What Groot spawns. */
  readonly path: string;
  /** The PATH entry or override that led here. */
  readonly via: string;
  readonly kind: "override" | "native" | "node-launcher" | "script";
  readonly prependPath: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>>;
}

export interface Resolution {
  readonly executable: ResolvedExecutable | null;
  readonly notes: readonly string[];
}

const COMMAND: Record<RunnerId, string> = { "claude-code": "claude", codex: "codex" };
export const OVERRIDE_ENV: Record<RunnerId, string> = {
  "claude-code": "GROOT_CLAUDE_PATH",
  codex: "GROOT_CODEX_PATH",
};

const HEAD_BYTES = 64 * 1024;
const WRAPPER_TEXT = [/cmux-[a-z0-9-]*wrapper/i, /\bexec\b[^\n]*wrapper/i];

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First bytes of a file (scripts are recognized by their `#!`). */
function readHead(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, read).toString("latin1");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function isWrapperShim(path: string, head: string): boolean {
  if (path.includes("cmux-cli-shims")) return true;
  return head.startsWith("#!") && WRAPPER_TEXT.some((pattern) => pattern.test(head));
}

const TRIPLES: Record<string, string> = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/** The native binary the Codex launcher would spawn, if installed. */
export function codexNativeBehindLauncher(
  launcherRealPath: string,
): { path: string; pathDir: string | null } | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[platformKey];
  if (triple === undefined) return null;
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  const pkgRoot = dirname(dirname(launcherRealPath)); // …/@openai/codex
  const platformPkg = `codex-${platformKey}`;
  const vendorRoots = [
    join(pkgRoot, "node_modules", "@openai", platformPkg, "vendor"),
    join(dirname(pkgRoot), platformPkg, "vendor"),
    join(pkgRoot, "vendor"),
  ];
  for (const vendor of vendorRoots) {
    const candidate = join(vendor, triple, "codex", binary);
    if (isExecutableFile(candidate)) {
      const pathDir = join(vendor, triple, "path");
      return { path: candidate, pathDir: isDirectory(pathDir) ? pathDir : null };
    }
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isCodexLauncher(realPath: string): boolean {
  return /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/.test(realPath);
}

function fromCandidate(
  runner: RunnerId,
  candidate: string,
  real: string,
  head: string,
): { executable: ResolvedExecutable; notes: string[] } {
  if (runner === "codex" && isCodexLauncher(real)) {
    const native = codexNativeBehindLauncher(real);
    const managedBy = real.includes(`${join(".bun", "install", "global")}`) ? "BUN" : "NPM";
    if (native !== null) {
      return {
        executable: {
          path: native.path,
          via: candidate,
          kind: "native",
          prependPath: native.pathDir === null ? [] : [native.pathDir],
          extraEnv: { [`CODEX_MANAGED_BY_${managedBy}`]: "1" },
        },
        notes: [`using the native Codex binary behind the npm launcher ${candidate}`],
      };
    }
    return {
      executable: {
        path: candidate,
        via: candidate,
        kind: "node-launcher",
        prependPath: [],
        extraEnv: {},
      },
      notes: [
        `native Codex binary not found behind ${candidate}; cancellation signals the launcher's whole process group`,
      ],
    };
  }
  const kind = head.startsWith("#!") ? "script" : "native";
  return {
    executable: { path: candidate, via: candidate, kind, prependPath: [], extraEnv: {} },
    notes: [],
  };
}

function resolveOverride(runner: RunnerId, value: string): Resolution {
  const name = OVERRIDE_ENV[runner];
  if (!isExecutableFile(value)) {
    return { executable: null, notes: [`${name}=${value} is not an executable file`] };
  }
  return {
    executable: { path: value, via: name, kind: "override", prependPath: [], extraEnv: {} },
    notes: [`using ${name}=${value}`],
  };
}

/** Find the real executable for a runner (see the module comment for the order). */
export function resolveExecutable(
  runner: RunnerId,
  env: Readonly<Record<string, string | undefined>>,
): Resolution {
  const override = env[OVERRIDE_ENV[runner]];
  if (override !== undefined && override.trim() !== "") return resolveOverride(runner, override);

  const command = COMMAND[runner];
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`] : [command];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const head = readHead(real);
      if (isWrapperShim(candidate, head) || isWrapperShim(real, head)) {
        notes.push(`skipped wrapper shim ${candidate} (it rewrites the agent's argv/env)`);
        continue;
      }
      const found = fromCandidate(runner, candidate, real, head);
      return { executable: found.executable, notes: [...notes, ...found.notes] };
    }
  }
  const hint = `set ${OVERRIDE_ENV[runner]} to the real ${basename(command)} executable`;
  return {
    executable: null,
    notes: [
      ...notes,
      notes.length > 0
        ? `only wrapper shims found on PATH; ${hint}`
        : `${command} not found on PATH`,
    ],
  };
}
