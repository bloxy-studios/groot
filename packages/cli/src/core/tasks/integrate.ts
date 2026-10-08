/**
 * Integration of an approved task — nothing reaches the user's branch
 * without fresh proof:
 *
 * 1. Require an approved review of the CURRENT task head.
 * 2. Fresh integration worktree from the target branch's current HEAD
 *    (`.groot/worktrees/integrate-<id>` on `groot/integrate/<id>`), then
 *    `git merge --no-ff groot/task/<id>`. Conflicts are aborted, cleaned up,
 *    and reported (`conflicted`).
 * 3. Install the worktree's dependencies, re-run the task's acceptance
 *    criteria plus the structural and build profiles there (fresh evidence;
 *    the change was reviewed, so the checks get the caller's environment).
 * 4. Only when every check passed — a check that could not run (`blocked`)
 *    gates like a failure; only an unregistered project's skipped
 *    structural/build verification does not — AND the main checkout is clean
 *    and on the target branch: `git merge --ff-only groot/integrate/<id>`
 *    there; the task becomes `completed`. A dirty (or switched) checkout is
 *    never touched — the integration branch is left ready and the result is
 *    `blocked`.
 *
 * Worktrees are removed afterwards; branches are kept for audit.
 */
import type { Task } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { nowIso } from "../ids.ts";
import { knownSecretsFromEnv } from "../runners/index.ts";
import type { CoreContext } from "../runtime.ts";
import { type ProfileRun, runAcceptance, verifyWorktree } from "./acceptance.ts";
import {
  currentBranch,
  deleteBranch,
  type Env,
  freshWorktree,
  gitRun,
  mergeNoFf,
  removeWorktree,
  repositoryRoot,
  revParse,
  statusEntries,
} from "./git-ops.ts";
import { withProjectLock } from "./lock.ts";
import { blockedAfterReview } from "./run.ts";
import {
  type AcceptanceRecord,
  integrationBranch,
  producedBySimulation,
  readReview,
  readTask,
  taskBranch,
  taskPaths,
  touch,
  writeTask,
} from "./store.ts";

type Integration = NonNullable<Task["integration"]>;

const short = (sha: string | null): string => (sha ?? "?").slice(0, 12);

function stateError(message: string, hint: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_TASK_STATE", message, { hint });
}

async function requireApproved(
  root: string,
  task: Task,
  env: Env,
): Promise<{ head: string; target: string; targetHead: string }> {
  if (task.status !== "awaiting-review" && !blockedAfterReview(task)) {
    throw stateError(
      `Task ${task.id} is ${task.status}; only reviewed tasks can be integrated.`,
      task.status === "completed" ? "It is already integrated." : `See groot task show ${task.id}.`,
    );
  }
  const head = await revParse(root, `refs/heads/${taskBranch(task.id)}`, env);
  const review =
    task.review === null ? null : await readReview(root, task.review).catch(() => null);
  if (head === null || review === null || review.verdict !== "approved") {
    throw stateError(
      `Task ${task.id} needs an approved review before integration.`,
      `Review it: groot review ${task.id} --approve`,
    );
  }
  if (review.head !== head) {
    throw stateError(
      `The approved review covers ${short(review.head)}, but the task branch is at ${short(head)}.`,
      `Review the current change: groot review ${task.id}`,
    );
  }
  const target = task.base.branch;
  if (target === null) {
    throw stateError(
      `Task ${task.id} was created from a detached HEAD; there is no target branch.`,
      `Merge ${taskBranch(task.id)} yourself.`,
    );
  }
  const targetHead = await revParse(root, `refs/heads/${target}`, env);
  if (targetHead === null) {
    throw stateError(
      `The target branch ${target} no longer exists.`,
      `Merge ${taskBranch(task.id)} yourself.`,
    );
  }
  return { head, target, targetHead };
}

function record(
  ctx: CoreContext,
  root: string,
  task: Task,
  status: Task["status"],
  integration: Omit<Integration, "at">,
): Task {
  const done = writeTask(
    root,
    touch(task, {
      status,
      statusReason: status === "completed" ? null : integration.detail,
      integration: { ...integration, at: nowIso() },
      evidence: [
        ...task.evidence,
        ...integration.evidence.filter((id) => !task.evidence.includes(id)),
      ],
      ...(status === "completed" ? { worktree: null } : {}),
    }),
  );
  ctx.events.emit({
    type: `task.integration.${integration.status}`,
    level: integration.status === "integrated" ? "info" : "warn",
    message: `${task.id}: ${integration.detail}`,
    taskId: task.id,
    data: { status: integration.status, commit: integration.commit },
  });
  return done;
}

/** Why the main checkout can't be fast-forwarded right now (null when it can). */
async function checkoutObstacle(root: string, target: string, env: Env): Promise<string | null> {
  const dirty = await statusEntries(root, env);
  if (dirty.length > 0)
    return `the main checkout has uncommitted changes (${dirty.length} path(s))`;
  const branch = await currentBranch(root, env);
  return branch === target
    ? null
    : `the main checkout is on ${branch ?? "a detached HEAD"}, not ${target}`;
}

interface FreshChecks {
  readonly acceptance: readonly AcceptanceRecord[];
  readonly verification: ProfileRun;
  readonly evidence: string[];
}

/** Dependencies, acceptance criteria, then structural + build verification in the integration worktree. */
async function freshChecks(
  ctx: CoreContext,
  root: string,
  task: Task,
  worktree: string,
): Promise<FreshChecks> {
  const run = {
    root,
    cwd: worktree,
    task,
    simulated: await producedBySimulation(root, task),
    reviewed: true,
    secrets: knownSecretsFromEnv(ctx.env),
  };
  const acceptance = await runAcceptance(ctx, run, "always");
  const verification = await verifyWorktree(
    ctx,
    run,
    ["structural", "build"],
    "integration-verify",
    "skipped",
  );
  const evidence = [...acceptance.flatMap((entry) => entry.evidence), ...verification.evidence];
  return { acceptance, verification, evidence };
}

/** What kept the fresh checks from passing (empty: everything that gates passed). */
function checkProblems(checks: FreshChecks): string[] {
  const { acceptance, verification } = checks;
  const skippedUnregistered = !verification.registered && verification.status === "skipped";
  return [
    ...acceptance
      .filter((entry) => entry.status !== "pass")
      .map((entry) => `${entry.criterion}: ${entry.summary}`),
    ...(verification.status === "pass" || skippedUnregistered
      ? []
      : [
          `${verification.status}: ${verification.summary}${verification.failures === "" ? "" : ` (${verification.failures.split("\n").join("; ")})`}`,
        ]),
  ];
}

/** "after fresh checks passed" — only when verification ran and passed too. */
function passedChecks(checks: FreshChecks): string {
  return checks.verification.registered
    ? "after fresh checks passed"
    : `after the task's acceptance checks passed (structural/build verification skipped: ${checks.verification.summary})`;
}

async function fastForward(
  ctx: CoreContext,
  root: string,
  task: Task,
  merge: { branch: string; target: string; commit: string | null; checks: FreshChecks },
): Promise<Task> {
  const { branch, target, commit, checks } = merge;
  const base = { targetBranch: target, evidence: checks.evidence };
  const obstacle = await checkoutObstacle(root, target, ctx.env);
  if (obstacle !== null) {
    return record(ctx, root, task, "blocked", {
      ...base,
      status: "failed",
      commit: null,
      detail: `${obstacle} — groot never touches it. ${branch} is verified and ready at ${short(commit)}: merge it yourself, or clean up and run \`groot task integrate ${task.id}\` again`,
    });
  }
  const ff = await gitRun(root, ["merge", "--ff-only", "--no-edit", branch], ctx.env);
  if (ff.exitCode !== 0) {
    return record(ctx, root, task, "blocked", {
      ...base,
      status: "failed",
      commit: null,
      detail: `${target} moved during integration (fast-forward refused) — run \`groot task integrate ${task.id}\` again`,
    });
  }
  await removeWorktree(root, taskPaths.worktree(root, task.id), ctx.env);
  return record(ctx, root, task, "completed", {
    ...base,
    status: "integrated",
    commit,
    detail: `fast-forwarded ${target} to ${short(commit)} ${passedChecks(checks)}`,
  });
}

async function integrateMerged(
  ctx: CoreContext,
  root: string,
  task: Task,
  merge: { branch: string; target: string; worktree: string },
): Promise<Task> {
  const { branch, target, worktree } = merge;
  const commit = await revParse(worktree, "HEAD", ctx.env);
  const checks = await freshChecks(ctx, root, task, worktree);
  const base = { targetBranch: target, evidence: checks.evidence, commit: null };
  if (ctx.signal.aborted) {
    return record(ctx, root, task, task.status, {
      ...base,
      status: "failed",
      detail: `integration was interrupted before ${target} changed — run it again`,
    });
  }
  const problems = checkProblems(checks);
  if (problems.length > 0) {
    return record(ctx, root, task, "blocked", {
      ...base,
      status: "failed",
      detail: `fresh checks on the merged result did not all pass (${problems.join("; ")}); nothing changed on ${target}`,
    });
  }
  return fastForward(ctx, root, task, { branch, target, commit, checks });
}

async function integrateLocked(ctx: CoreContext, root: string, id: string): Promise<Task> {
  const env = ctx.env;
  const task = await readTask(root, id);
  const { target, targetHead } = await requireApproved(root, task, env);
  const branch = integrationBranch(id);
  const path = taskPaths.worktree(root, `integrate-${id}`);
  const worktree = await freshWorktree(root, path, branch, targetHead, env);
  try {
    const message = `groot: integrate ${task.title}\n\nTask ${id}.`;
    const merge = await mergeNoFf(worktree, taskBranch(id), message, env);
    if (merge.ok) return await integrateMerged(ctx, root, task, { branch, target, worktree });
    await removeWorktree(root, path, env);
    await deleteBranch(root, branch, env);
    const files = merge.conflicts.length > 0 ? merge.conflicts.join(", ") : merge.detail;
    return record(ctx, root, task, "blocked", {
      targetBranch: target,
      status: "conflicted",
      commit: null,
      evidence: [],
      detail: `merging ${taskBranch(id)} into ${target} conflicts (${files}); nothing changed on ${target}`,
    });
  } finally {
    await removeWorktree(root, path, env);
  }
}

/** Integrate an approved task into its target branch (see the module comment). */
export async function integrateTask(ctx: CoreContext, root: string, id: string): Promise<Task> {
  const repo = await repositoryRoot(root, ctx.env);
  return withProjectLock(repo, "task integrate", () => integrateLocked(ctx, repo, id));
}
