/**
 * `groot review <taskId> [--approve | --request-changes <notes>]` — the
 * human gate between an agent's change and the user's branch
 * (docs/v2-cli-spec.md#groot-task). Shows files, ownership violations,
 * secret findings (locations only), and acceptance results; records the
 * decision. Requesting changes sends the task back to `pending`: the next
 * `groot task run` resumes the same agent session with the notes.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import type { Review } from "../core/contracts/task.ts";
import { reviewTask } from "../core/tasks/index.ts";
import { taskRoot } from "./task.ts";

const MARK: Record<Review["files"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function nextFor(review: Review): string {
  switch (review.verdict) {
    case "approved":
      return `groot task integrate ${review.taskId}`;
    case "changes-requested":
      return `groot task run ${review.taskId}  (resumes the agent with your notes)`;
    case "pending":
      return `groot review ${review.taskId} --approve   or   --request-changes "<notes>"`;
  }
}

export function renderReview(review: Review): void {
  console.log(`${pc.bold(review.id)} for ${review.taskId} — ${pc.bold(review.verdict)}`);
  console.log(`  ${pc.dim("change:")} ${review.base.slice(0, 12)} → ${review.head.slice(0, 12)}`);
  console.log(`  ${pc.dim(`files (${review.files.length}):`)}`);
  for (const file of review.files) {
    const outside = file.withinOwnership ? "" : pc.red("  ✗ outside ownership");
    console.log(
      `    ${MARK[file.status]} ${file.path}  ${pc.green(`+${file.additions}`)} ${pc.red(`-${file.deletions}`)}${outside}`,
    );
  }
  for (const entry of review.acceptance) {
    const color = entry.status === "pass" ? pc.green : entry.status === "fail" ? pc.red : pc.yellow;
    console.log(
      `  ${pc.dim("acceptance:")} ${entry.criterion} ${color(entry.status)}${entry.evidence === null ? "" : pc.dim(` (${entry.evidence})`)}`,
    );
  }
  if (review.ownershipViolations.length > 0) {
    console.log(`  ${pc.red("ownership violations:")} ${review.ownershipViolations.join(", ")}`);
  }
  if (review.secretFindings.length > 0) {
    console.log(`  ${pc.red("secret findings:")}`);
    for (const finding of review.secretFindings) console.log(`    ${finding}`);
  }
  if (review.notes !== null) console.log(`  ${pc.dim("notes:")} ${review.notes}`);
  console.log(`  ${pc.cyan("next:")} ${nextFor(review)}`);
}

export const review = defineCommand({
  meta: { name: "review", description: "Review a task's change; approve it or request changes" },
  args: {
    taskId: { type: "positional", required: true, description: "Task id" },
    approve: { type: "boolean", default: false, description: "Approve the change for integration" },
    "request-changes": {
      type: "string",
      description: "Send the task back to the agent with these notes",
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("review", { json: args.json, events: args.events }, async (ctx) => {
      const result = await reviewTask(ctx, await taskRoot(ctx), args.taskId, {
        ...(args.approve ? { approve: true } : {}),
        ...(args["request-changes"] === undefined
          ? {}
          : { requestChanges: args["request-changes"] }),
      });
      const evidence = result.acceptance
        .map((entry) => entry.evidence)
        .filter((id): id is string => id !== null);
      return {
        ok: true,
        data: result,
        warnings: [
          ...result.ownershipViolations.map((path) => `outside the task's ownership: ${path}`),
          ...result.secretFindings.map((finding) => `possible secret: ${finding}`),
        ],
        refs: { taskId: result.taskId, evidence },
        human: () => renderReview(result),
      };
    });
  },
});
