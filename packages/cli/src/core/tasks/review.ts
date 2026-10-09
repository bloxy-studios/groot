/**
 * Task review: summarize `base.commit..groot/task/<id>` as a Review document
 * (.groot/reviews/<reviewId>.json) — files with status and line counts,
 * whether each lies within the task's ownership globs, ownership violations,
 * secret-looking additions (locations only), and the acceptance results from
 * stored evidence — then record a human decision: approve, or request
 * changes (the task returns to `pending` and the next run resumes the same
 * session with the reviewer's notes). Integration requires an approved
 * review of the CURRENT task head. A decision is written under the project
 * lock; merely looking never waits for it.
 */
import { schemaUrl } from "../contracts/common.ts";
import { Review, type Task } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { newId, nowIso } from "../ids.ts";
import { truncate } from "../runners/common.ts";
import type { CoreContext } from "../runtime.ts";
import { type Env, gitReadRaw, repositoryRoot, revParse } from "./git-ops.ts";
import { tryWithProjectLock, withProjectLock } from "./lock.ts";
import { matchesOwnership } from "./ownership.ts";
import { blockedAfterReview } from "./run.ts";
import { findSecrets, parseAddedLines } from "./secrets.ts";
import {
  latestAcceptance,
  readReview,
  readTask,
  saveReview,
  taskBranch,
  touch,
  writeTask,
} from "./store.ts";
import type { ReviewDecision } from "./types.ts";

type ReviewFile = Review["files"][number];

/** How long a view-only review waits for the project lock before returning unrecorded. */
const VIEW_LOCK_WAIT_MS = 2000;

const STATUS: Record<string, ReviewFile["status"]> = {
  A: "added",
  C: "added",
  M: "modified",
  T: "modified",
  D: "deleted",
  R: "renamed",
};

interface ChangedPath {
  readonly status: ReviewFile["status"];
  readonly path: string;
  readonly from: string | null;
}

/** Parse `git diff --name-status -z -M` (renames/copies carry two paths). */
export function parseNameStatus(output: string): ChangedPath[] {
  const tokens = output.split("\0").filter((token) => token !== "");
  const changes: ChangedPath[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const letter = (tokens[i] as string).charAt(0);
    const status = STATUS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      changes.push({ status, from: tokens[i + 1] ?? null, path: tokens[i + 2] ?? "" });
      i += 2;
    } else {
      changes.push({ status, from: null, path: tokens[i + 1] ?? "" });
      i += 1;
    }
  }
  return changes;
}

/** Parse `git diff --numstat -z -M` into path → [additions, deletions] (binary = 0/0). */
export function parseNumstat(output: string): Map<string, [number, number]> {
  const tokens = output.split("\0");
  const counts = new Map<string, [number, number]>();
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i] as string);
    if (match === null) continue;
    const add = match[1] === "-" ? 0 : Number(match[1]);
    const del = match[2] === "-" ? 0 : Number(match[2]);
    if (match[3] !== "") {
      counts.set(match[3] as string, [add, del]);
    } else {
      counts.set(tokens[i + 2] ?? "", [add, del]); // rename: old, new follow
      i += 2;
    }
  }
  return counts;
}

function validateDecision(decision: ReviewDecision): void {
  if (decision.approve === true && decision.requestChanges !== undefined) {
    throw new GrootV2Error("GROOT_E_USAGE", "Approve or request changes — not both.");
  }
  if (decision.requestChanges !== undefined && decision.requestChanges.trim() === "") {
    throw new GrootV2Error("GROOT_E_USAGE", "Requesting changes needs notes for the agent.", {
      hint: 'Example: groot review <id> --request-changes "keep the public API unchanged"',
    });
  }
}

async function summarize(
  root: string,
  task: Task,
  head: string,
  env: Env,
): Promise<Pick<Review, "files" | "ownershipViolations" | "secretFindings">> {
  const range = [task.base.commit, head];
  // No external diff or textconv program runs: the diff is of code nobody has reviewed yet.
  const quiet = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ];
  // Raw (unredacted) reads: exact paths, and the secret scan must see real
  // content. Only locations and kinds leave this function.
  const [names, numstat, patch] = await Promise.all([
    gitReadRaw(
      root,
      [...quiet, "--name-status", "-z", "-M", ...range],
      env,
      "Listing the task's changes",
    ),
    gitReadRaw(
      root,
      [...quiet, "--numstat", "-z", "-M", ...range],
      env,
      "Counting the task's changes",
    ),
    gitReadRaw(root, [...quiet, "-U0", ...range], env, "Reading the task's diff"),
  ]);
  const counts = parseNumstat(numstat);
  const violations: string[] = [];
  const files = parseNameStatus(names).map((change): ReviewFile => {
    const paths = change.from === null ? [change.path] : [change.from, change.path];
    const within = paths.every((path) => matchesOwnership(path, task.ownership));
    if (!within)
      violations.push(change.from === null ? change.path : `${change.from} → ${change.path}`);
    const [additions, deletions] = counts.get(change.path) ?? [0, 0];
    return {
      path: change.path,
      status: change.status,
      additions,
      deletions,
      withinOwnership: within,
    };
  });
  const addedFiles = files.filter((file) => file.status === "added").map((file) => file.path);
  return {
    files,
    ownershipViolations: violations,
    secretFindings: findSecrets(parseAddedLines(patch), addedFiles),
  };
}

async function acceptanceSummary(root: string, task: Task): Promise<Review["acceptance"]> {
  const records = (await latestAcceptance(root, task)) ?? [];
  return task.acceptance.map((criterion) => {
    const record = records.find((entry) => entry.criterion === criterion.id);
    return {
      criterion: criterion.id,
      status: record?.status ?? "skipped",
      evidence: record?.evidence[0] ?? null,
    };
  });
}

const isDeciding = (decision: ReviewDecision): boolean =>
  decision.approve === true || decision.requestChanges !== undefined;

/** The task and its branch head, when the task has a finished change that can take `decision`. */
async function reviewable(
  root: string,
  id: string,
  decision: ReviewDecision,
  env: Env,
): Promise<{ task: Task; head: string }> {
  const task = await readTask(root, id);
  const head = await revParse(root, `refs/heads/${taskBranch(id)}`, env);
  if (task.attempts.length === 0 || head === null || task.status === "running") {
    throw new GrootV2Error(
      "GROOT_E_TASK_STATE",
      `Task ${id} has no finished changes to review (status: ${task.status}).`,
      {
        hint:
          task.status === "running"
            ? "Wait for the run to finish."
            : `Run it first: groot task run ${id}`,
      },
    );
  }
  if (isDeciding(decision) && task.status !== "awaiting-review" && !blockedAfterReview(task)) {
    throw new GrootV2Error(
      "GROOT_E_TASK_STATE",
      `Task ${id} is ${task.status}; only a task awaiting review takes a decision.`,
      { hint: task.statusReason ?? `See groot task show ${id}.` },
    );
  }
  return { task, head };
}

type ReviewContent = Pick<
  Review,
  "files" | "ownershipViolations" | "secretFindings" | "acceptance"
>;

interface Reviewable {
  readonly task: Task;
  readonly head: string;
}

/** The review document for the task's current change (same id while base and head are unchanged). */
async function composeReview(
  root: string,
  current: Reviewable,
  content: ReviewContent,
  decision: ReviewDecision,
): Promise<Review> {
  const { task, head } = current;
  const previous =
    task.review === null ? null : await readReview(root, task.review).catch(() => null);
  const same = previous !== null && previous.head === head && previous.base === task.base.commit;
  return Review.parse({
    $schema: schemaUrl("review"),
    schemaVersion: 1,
    kind: "groot.review",
    id: same ? previous.id : newId("rev"),
    taskId: task.id,
    createdAt: same ? previous.createdAt : nowIso(),
    base: task.base.commit,
    head,
    ...content,
    verdict: decision.approve
      ? "approved"
      : decision.requestChanges !== undefined
        ? "changes-requested"
        : same
          ? previous.verdict
          : "pending",
    reviewer: isDeciding(decision) ? "human" : same ? previous.reviewer : null,
    notes: decision.requestChanges?.trim() ?? (same ? previous.notes : null),
  });
}

/** Save the review and point the task at it (requested changes send it back to `pending`). */
async function recordReview(
  root: string,
  current: Reviewable,
  content: ReviewContent,
  decision: ReviewDecision,
): Promise<Review> {
  const { task } = current;
  const review = saveReview(root, await composeReview(root, current, content, decision));
  const sentBack = review.verdict === "changes-requested" && decision.requestChanges !== undefined;
  writeTask(
    root,
    touch(task, {
      review: review.id,
      ...(sentBack
        ? {
            status: "pending" as const,
            statusReason: `changes requested in ${review.id}: ${truncate(review.notes ?? "", 200)}`,
          }
        : {}),
    }),
  );
  return review;
}

/**
 * A view-only review: recorded when the project lock is free, otherwise
 * (an integration holds it for minutes) returned unrecorded with a warning —
 * looking at a change never waits for, or fails on, another operation.
 */
async function viewOnly(
  ctx: CoreContext,
  root: string,
  read: Reviewable,
  content: ReviewContent,
  write: () => Promise<Review>,
): Promise<Review> {
  const recorded = await tryWithProjectLock(root, "review", write, VIEW_LOCK_WAIT_MS);
  if (recorded.held) return recorded.value;
  const review = await composeReview(root, read, content, {});
  ctx.events.emit({
    type: "task.warning",
    level: "warn",
    message: `${read.task.id}: review ${review.id} shows the current change but was not recorded (${recorded.reason}); run \`groot review ${read.task.id}\` again to record it`,
    taskId: read.task.id,
  });
  return review;
}

/**
 * Build (or refresh) the task's review and record a decision when given. The
 * diff is summarized first; the review and the task are then written under
 * the project lock against a FRESH read — a task that changed meanwhile (a
 * new run, another decision) is refused instead of overwritten. A decision
 * waits for the lock; a view-only review does not (see viewOnly).
 */
export async function reviewTask(
  ctx: CoreContext,
  root: string,
  id: string,
  decision: ReviewDecision = {},
): Promise<Review> {
  validateDecision(decision);
  const repo = await repositoryRoot(root, ctx.env);
  const read = await reviewable(repo, id, decision, ctx.env);
  const content: ReviewContent = {
    ...(await summarize(repo, read.task, read.head, ctx.env)),
    acceptance: await acceptanceSummary(repo, read.task),
  };
  const write = async (): Promise<Review> => {
    const fresh = await reviewable(repo, id, decision, ctx.env);
    if (fresh.head !== read.head || fresh.task.updatedAt !== read.task.updatedAt) {
      throw new GrootV2Error(
        "GROOT_E_TASK_STATE",
        `Task ${id} changed while it was being reviewed.`,
        {
          hint: `Review it again: groot review ${id}`,
        },
      );
    }
    return recordReview(repo, fresh, content, decision);
  };
  const review = isDeciding(decision)
    ? await withProjectLock(repo, "review", write)
    : await viewOnly(ctx, repo, read, content, write);
  ctx.events.emit({
    type: "task.review",
    level: review.ownershipViolations.length + review.secretFindings.length > 0 ? "warn" : "info",
    message: `${id}: review ${review.id} ${review.verdict} — ${review.files.length} file(s), ${review.ownershipViolations.length} ownership violation(s), ${review.secretFindings.length} secret finding(s)`,
    taskId: id,
    data: { review: review.id, verdict: review.verdict },
  });
  return review;
}
