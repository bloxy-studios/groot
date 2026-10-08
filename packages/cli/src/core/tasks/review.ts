/**
 * Task review: summarize `base.commit..groot/task/<id>` as a Review document
 * (.groot/reviews/<reviewId>.json) — files with status and line counts,
 * whether each lies within the task's ownership globs, ownership violations,
 * secret-looking additions (locations only), and the acceptance results from
 * stored evidence — then record a human decision: approve, or request
 * changes (the task returns to `pending` and the next run resumes the same
 * session with the reviewer's notes). Integration requires an approved
 * review of the CURRENT task head.
 */
import { schemaUrl } from "../contracts/common.ts";
import type { Review, Task } from "../contracts/task.ts";
import { GrootV2Error } from "../errors.ts";
import { newId, nowIso } from "../ids.ts";
import { truncate } from "../runners/common.ts";
import type { CoreContext } from "../runtime.ts";
import { type Env, gitReadRaw, repositoryRoot, revParse } from "./git-ops.ts";
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
  const quiet = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff"];
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

/** Build (or refresh) the task's review and record a decision when given. */
export async function reviewTask(
  ctx: CoreContext,
  root: string,
  id: string,
  decision: ReviewDecision = {},
): Promise<Review> {
  validateDecision(decision);
  const repo = await repositoryRoot(root, ctx.env);
  const task = await readTask(repo, id);
  const head = await revParse(repo, `refs/heads/${taskBranch(id)}`, ctx.env);
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
  const deciding = decision.approve === true || decision.requestChanges !== undefined;
  if (deciding && task.status !== "awaiting-review" && !blockedAfterReview(task)) {
    throw new GrootV2Error(
      "GROOT_E_TASK_STATE",
      `Task ${id} is ${task.status}; only a task awaiting review takes a decision.`,
      { hint: task.statusReason ?? `See groot task show ${id}.` },
    );
  }
  const previous =
    task.review === null ? null : await readReview(repo, task.review).catch(() => null);
  const same = previous !== null && previous.head === head && previous.base === task.base.commit;
  const review = saveReview(repo, {
    $schema: schemaUrl("review"),
    schemaVersion: 1,
    kind: "groot.review",
    id: same ? previous.id : newId("rev"),
    taskId: id,
    createdAt: same ? previous.createdAt : nowIso(),
    base: task.base.commit,
    head,
    ...(await summarize(repo, task, head, ctx.env)),
    acceptance: await acceptanceSummary(repo, task),
    verdict: decision.approve
      ? "approved"
      : decision.requestChanges !== undefined
        ? "changes-requested"
        : same
          ? previous.verdict
          : "pending",
    reviewer: deciding ? "human" : same ? previous.reviewer : null,
    notes: decision.requestChanges?.trim() ?? (same ? previous.notes : null),
  });
  const sentBack = review.verdict === "changes-requested" && decision.requestChanges !== undefined;
  writeTask(
    repo,
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
  ctx.events.emit({
    type: "task.review",
    level: review.ownershipViolations.length + review.secretFindings.length > 0 ? "warn" : "info",
    message: `${id}: review ${review.id} ${review.verdict} — ${review.files.length} file(s), ${review.ownershipViolations.length} ownership violation(s), ${review.secretFindings.length} secret finding(s)`,
    taskId: id,
    data: { review: review.id, verdict: review.verdict },
  });
  return review;
}
