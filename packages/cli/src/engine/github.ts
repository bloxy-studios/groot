/**
 * GitHub publishing — `groot init --github` (docs/cli-spec.md#groot-init).
 *
 * Runs AFTER verify's initial commit: detect gh → check auth → create + push.
 * Every behavior verified against the published gh sources
 * (pkg/cmd/repo/create/create.go) and the real 2.96.0 binary:
 *
 * - `--public`/`--private`/`--internal`: exactly one is REQUIRED when
 *   non-interactive — groot always passes one (private unless --public).
 * - `--source` must point at a git repo, and `--push` hard-errors on a repo
 *   with zero commits — which is why --github validates the git identity up
 *   front (commands/init.ts) instead of downgrading a failed commit to a
 *   hint like plain init does.
 * - Unauthenticated: `gh auth status` exits 1; `gh repo create` exits 4 and
 *   its auth check fires before any local validation.
 * - Non-TTY success output is the bare repository URL on stdout.
 *
 * This module NEVER throws and never fails the run: gh absent, gh
 * unauthenticated, or a failed create all degrade to a structured result the
 * command layer prints as manual fallback steps — the workspace itself is
 * already valid, so the scaffold exits 0 (issue #44's contract).
 */

export type GitHubPublishStatus = "created" | "gh-missing" | "gh-unauthenticated" | "failed";

export interface GitHubPublishResult {
  readonly status: GitHubPublishStatus;
  /** One-line human summary of what happened. */
  readonly note: string;
  /** The repository URL (gh's non-TTY stdout) when status === "created". */
  readonly url?: string;
  /** Manual commands to print as next steps when the publish degraded. */
  readonly fallback: readonly string[];
}

export interface GitHubPublishOptions {
  /** Repository name — the workspace name. */
  readonly name: string;
  /** Workspace root; the create runs here with `--source=.`. */
  readonly targetDir: string;
  readonly visibility: "private" | "public";
  /** Overridable for hermetic tests (PATH manipulation + fake gh shims). */
  readonly env?: Record<string, string | undefined>;
}

/** The manual invocation printed whenever groot couldn't run it itself. */
export function ghCreateCommand(name: string, visibility: "private" | "public"): string {
  return `gh repo create ${name} --${visibility} --source=. --remote=origin --push`;
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Both halves of the git identity the initial commit needs. Checked up front
 * for --github (the ordering fix): without it, verify would downgrade the
 * commit to a hint and `gh repo create --push` would then hard-error on a
 * commit-less repo — better to refuse before anything is generated.
 */
export async function gitIdentityPresent(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  for (const key of ["user.name", "user.email"]) {
    const { exitCode, stdout } = await run(["git", "config", "--get", key], cwd, env);
    if (exitCode !== 0 || stdout.trim() === "") return false;
  }
  return true;
}

/**
 * True when `cwd` sits in a git work tree with at least one commit. The
 * second --github precondition: merging into an existing `.git` makes verify
 * skip its init+commit block, and `gh repo create --push` hard-errors on a
 * commit-less repo — refuse up front instead of degrading after generation.
 */
export async function hasCommits(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const { exitCode } = await run(["git", "rev-parse", "--verify", "HEAD"], cwd, env);
  return exitCode === 0;
}

/** Create the GitHub repository and push the initial commit. Never throws. */
export async function publishToGitHub(options: GitHubPublishOptions): Promise<GitHubPublishResult> {
  const env = options.env ?? process.env;
  const manual = ghCreateCommand(options.name, options.visibility);

  const gh = Bun.which("gh", { PATH: env.PATH ?? "" });
  if (gh === null) {
    return {
      status: "gh-missing",
      note: "GitHub CLI (gh) not found on PATH — the repository was not created.",
      fallback: ["Install the GitHub CLI: https://cli.github.com", "gh auth login", manual],
    };
  }

  // Exit 1 when not logged in to any host (verified on gh 2.96.0).
  const auth = await run([gh, "auth", "status"], options.targetDir, env);
  if (auth.exitCode !== 0) {
    return {
      status: "gh-unauthenticated",
      note: "gh is installed but not logged in — the repository was not created.",
      fallback: ["gh auth login", manual],
    };
  }

  const create = await run(
    [
      gh,
      "repo",
      "create",
      options.name,
      `--${options.visibility}`,
      "--source=.",
      "--remote=origin",
      "--push",
    ],
    options.targetDir,
    env,
  );
  if (create.exitCode !== 0) {
    const reason = create.stderr.trim().split("\n")[0] ?? "unknown error";
    return {
      status: "failed",
      note: `gh repo create failed (exit ${create.exitCode}): ${reason}`,
      fallback: [manual],
    };
  }

  // Non-TTY success output is the bare repository URL.
  const url = create.stdout.match(/https:\/\/\S+/)?.[0];
  return {
    status: "created",
    note: `repository created and initial commit pushed (${options.visibility})`,
    ...(url === undefined ? {} : { url }),
    fallback: [],
  };
}
