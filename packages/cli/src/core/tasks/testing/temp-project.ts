/**
 * Test helper: a throwaway git repository holding a tiny Bun project with a
 * FAILING test (`add` subtracts), simulated runners, and a hermetic
 * environment (isolated git config, no inherited credentials). Never used by
 * production code. Every project is registered for `removeTempProjects()`
 * (call it from `afterAll`): repository, worktrees, git config, fake agents.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GrootEvent } from "../../contracts/envelope.ts";
import { type FakeAgents, installFakeAgents } from "../../runners/testing/fake-agents.ts";
import { type CoreContext, collectingSink, createContext } from "../../runtime.ts";

export const BROKEN_MATH =
  "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
export const FIXED_MATH =
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST =
  'import { expect, test } from "bun:test";\nimport { add } from "./math.ts";\n\ntest("adds two numbers", () => {\n  expect(add(1, 2)).toBe(3);\n});\n';

export interface TempProject {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly fakes: FakeAgents;
  /** Run git in the repository (throws on failure); returns stdout. */
  git(...args: string[]): Promise<string>;
  write(path: string, content: string): void;
  /** A CoreContext over the hermetic env (plus `extraEnv`) that records events. */
  context(
    signal?: AbortSignal,
    extraEnv?: Record<string, string>,
  ): CoreContext & { readonly log: GrootEvent[] };
}

const created: string[] = [];

/** Remove every temp project created so far (repositories, worktrees, configs, fakes). */
export function removeTempProjects(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function tempProject(): Promise<TempProject> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "groot-task-repo-")));
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "groot-task-gitconfig-")));
  const gitconfig = join(configDir, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = Groot Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  const fakes = installFakeAgents();
  created.push(root, configDir, fakes.root);
  const env = fakes.env({ GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" });
  const git = async (...args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    return stdout;
  };
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(
    "package.json",
    `${JSON.stringify({ name: "demo", private: true, type: "module" }, null, 2)}\n`,
  );
  write("src/math.ts", BROKEN_MATH);
  write("src/math.test.ts", MATH_TEST);
  write(".gitignore", "node_modules\n");
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");
  return {
    root,
    env,
    fakes,
    git,
    write,
    context(signal, extraEnv = {}) {
      const sink = collectingSink();
      return {
        ...createContext({ cwd: root, env: { ...env, ...extraEnv }, signal, events: sink }),
        log: sink.events,
      };
    },
  };
}
