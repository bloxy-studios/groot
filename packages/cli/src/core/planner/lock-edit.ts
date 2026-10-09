/**
 * Record changes in groot.lock.json through the plan: an exact-preview JSON
 * edit when the lock exists, or — for projects that predate it — the whole,
 * valid lock document written as one new file. Planners never assume the
 * lock exists.
 */
import { serializeLock } from "../blueprint/index.ts";
import { GrootLock } from "../contracts/lock.ts";
import type { JsonOp } from "../contracts/plan.ts";
import { applyEdit } from "../transforms/index.ts";
import type { PlanBuilder } from "./builder.ts";

const LOCK_PATH = "groot.lock.json";

export async function planLockUpdate(
  builder: PlanBuilder,
  lock: GrootLock,
  ops: readonly JsonOp[],
  description: string,
  owns: string[],
): Promise<void> {
  if ((await builder.currentContent(LOCK_PATH)) !== null) {
    await builder.editFile({
      path: LOCK_PATH,
      edit: { kind: "json", ops: [...ops] },
      description,
      owns,
      createIfMissing: false,
    });
    return;
  }
  const next = GrootLock.parse(
    JSON.parse(applyEdit(JSON.stringify(lock), { kind: "json", ops: [...ops] }, LOCK_PATH)),
  );
  await builder.writeFile({
    path: LOCK_PATH,
    content: serializeLock(next),
    description: `${description} (creating groot.lock.json)`,
    ownership: "file",
  });
}
