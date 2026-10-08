/**
 * Tasks — bounded work for installed coding agents, each in its own git
 * worktree, with acceptance evidence, human review, and verified
 * integration (docs/v2-architecture.md#agent-runners-and-tasks). The CLI,
 * the MCP server, and the coordinator import from here only.
 *
 * `readTask` / `listTasks` here are the surface reads: a run abandoned by a
 * dead Groot process is shown as it will be reconciled (interrupted, or
 * still running with the runner it left behind) — nothing is written or
 * signalled by reading.
 */
export { createTask } from "./create.ts";
export { integrateTask } from "./integrate.ts";
export { type ReadyRun, runReadyTasks, type StartFailure } from "./ready.ts";
export { showTask as readTask, showTasks as listTasks } from "./recovery.ts";
export { reviewTask } from "./review.ts";
export { resumeTask, runTask } from "./run.ts";
export type { CreateTaskInput, ReviewDecision, RunTaskOptions } from "./types.ts";
