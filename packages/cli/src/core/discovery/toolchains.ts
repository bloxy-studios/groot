/**
 * Toolchain version probes — the only processes discovery launches besides
 * git. bun, node, and git are always probed; native toolchains (cargo,
 * xcodebuild, pod, java, python3, go, flutter, docker) only when a detected
 * unit needs them.
 *
 * Probes run from a neutral directory (the OS temp dir), never the project:
 * version managers and toolchains read project files (a go.mod `toolchain`
 * line makes `go version` download a compiler; volta/asdf shims resolve
 * project pins), and discovery must not act on repository configuration.
 * GOTOOLCHAIN=local pins Go to the installed binary for the same reason.
 * A missing, failing, or hanging tool is `available: false` — never an error.
 */
import { tmpdir } from "node:os";
import type { Toolchain } from "../contracts/project.ts";
import { runProcess } from "../process.ts";

interface Probe {
  readonly argv: readonly string[];
  readonly darwinOnly?: boolean;
}

export const PROBES: Readonly<Record<string, Probe>> = {
  bun: { argv: ["bun", "--version"] },
  node: { argv: ["node", "--version"] },
  git: { argv: ["git", "--version"] },
  cargo: { argv: ["cargo", "--version"] },
  xcodebuild: { argv: ["xcodebuild", "-version"], darwinOnly: true },
  pod: { argv: ["pod", "--version"] },
  java: { argv: ["java", "-version"] },
  python3: { argv: ["python3", "--version"] },
  go: { argv: ["go", "version"] },
  flutter: { argv: ["flutter", "--version"] },
  docker: { argv: ["docker", "--version"] },
};

export const ALWAYS_PROBED = ["bun", "node", "git"] as const;
export const PROBE_TIMEOUT_MS = 5000;

/** First dotted version in a tool's banner ("cargo 1.79.0 (…)" → "1.79.0"). */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
}

async function probe(
  id: string,
  requiredBy: string[],
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<Toolchain> {
  const spec = PROBES[id] as Probe;
  const command = spec.argv.join(" ");
  const base = { id, requiredBy, version: null };
  if (spec.darwinOnly === true && process.platform !== "darwin") {
    return { ...base, available: false, source: `${spec.argv[0]} exists only on macOS` };
  }
  if (Bun.which(spec.argv[0] as string, { PATH: env.PATH ?? "" }) === null) {
    return { ...base, available: false, source: `${spec.argv[0]} not found on PATH` };
  }
  const result = await runProcess({
    argv: spec.argv,
    cwd: tmpdir(),
    env: { ...env, GOTOOLCHAIN: "local" },
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
    captureLimit: 64_000,
    killGraceMs: 500,
  });
  if (result.timedOut) {
    return { ...base, available: false, source: `${command} did not answer within 5 s` };
  }
  if (result.exitCode !== 0) {
    return {
      ...base,
      available: false,
      source: `${command} exited ${result.exitCode ?? result.signal ?? "abnormally"}`,
    };
  }
  return {
    ...base,
    available: true,
    version: parseVersion(`${result.stdout}\n${result.stderr}`),
    source: command,
  };
}

/** Probe the always-needed toolchains plus `needs` (toolchain id → units requiring it). */
export async function probeToolchains(
  needs: ReadonlyMap<string, ReadonlySet<string>>,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<Toolchain[]> {
  const extra = [...needs.keys()]
    .filter((id) => !(ALWAYS_PROBED as readonly string[]).includes(id) && id in PROBES)
    .sort();
  const ids = [...ALWAYS_PROBED, ...extra];
  return Promise.all(ids.map((id) => probe(id, [...(needs.get(id) ?? [])].sort(), env, signal)));
}
