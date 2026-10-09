/**
 * Test helper: installs SIMULATED `claude` and `codex` executables (Bun shims
 * over fake-agent.ts) in a temp directory and exposes the environment that
 * points Groot at them (GROOT_CLAUDE_PATH / GROOT_CODEX_PATH). Never used by
 * production code.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeScenario } from "./fake-agent.ts";

export type { FakeScenario, FakeStep } from "./fake-agent.ts";

export interface FakeRecord {
  readonly kind: "claude" | "codex";
  readonly argv: string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly pid: number;
  readonly envNames: string[];
  readonly env: Record<string, string | null>;
}

export interface FakeAgents {
  /** The temp root holding everything below (remove it when done). */
  readonly root: string;
  /** State directory (scenario.json, counters, records.jsonl). */
  readonly dir: string;
  readonly binDir: string;
  readonly claude: string;
  readonly codex: string;
  /** Environment pointing Groot at the fakes (merge into CoreContext.env). */
  env(extra?: Record<string, string>): Record<string, string>;
  /** Replace the scenario and reset per-kind invocation counters. */
  scenario(scenario: FakeScenario): void;
  /** Forget every Claude session the fake started (like `claude purge`). */
  forgetSessions(): void;
  records(): FakeRecord[];
  /** Pids of "hang" invocations whose processes (incl. a grandchild) are all running. */
  ready(): number[];
  /** Wait until `count` hang invocations are ready; returns the last one's pid. */
  waitReady(count?: number): Promise<number>;
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");

function writeShim(path: string, kind: "claude" | "codex"): void {
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.env.GROOT_FAKE_KIND = ${JSON.stringify(kind)};\nawait import(${JSON.stringify(FAKE_AGENT)});\n`,
  );
  chmodSync(path, 0o755);
}

/** A minimal, hermetic base environment for tests (no inherited credentials). */
export function hermeticEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pick = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "SHELL"];
  const env: Record<string, string> = {};
  for (const name of pick) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export function installFakeAgents(): FakeAgents {
  const root = mkdtempSync(join(tmpdir(), "groot-fake-agents-"));
  const binDir = join(root, "bin");
  const dir = join(root, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const claude = join(binDir, "claude");
  const codex = join(binDir, "codex");
  writeShim(claude, "claude");
  writeShim(codex, "codex");
  return {
    root,
    dir,
    binDir,
    claude,
    codex,
    env(extra = {}) {
      return hermeticEnv({
        GROOT_CLAUDE_PATH: claude,
        GROOT_CODEX_PATH: codex,
        GROOT_FAKE_DIR: dir,
        ...extra,
      });
    },
    scenario(scenario) {
      for (const name of readdirSync(dir)) {
        if (name.startsWith("count-")) rmSync(join(dir, name), { force: true });
      }
      writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    },
    forgetSessions() {
      rmSync(join(dir, "sessions.txt"), { force: true });
    },
    records() {
      return readJsonLines<FakeRecord>(join(dir, "records.jsonl"));
    },
    ready() {
      return readJsonLines<{ pid: number }>(join(dir, "ready.jsonl")).map((entry) => entry.pid);
    },
    async waitReady(count = 1) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const pids = this.ready();
        if (pids.length >= count) return pids[count - 1] as number;
        await Bun.sleep(50);
      }
      throw new Error("the simulated runner never became ready");
    },
  };
}
