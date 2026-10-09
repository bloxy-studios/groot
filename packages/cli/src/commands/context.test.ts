/**
 * Process-level tests for `groot context sync`: a hand edit skipped with
 * --skip-conflicts is reported (never "already in sync") and keeps its
 * ownership record; a policy that refuses sync's classes returns the saved
 * plan blocked, resolved by `groot apply <planId> --allow <class>` — sync has
 * no approvals of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registeredProject } from "../cli/test-support.ts";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import type { GrootLock } from "../core/contracts/lock.ts";
import { removeScratchDirs, runCli } from "../core/executor/test-support.ts";

afterAll(removeScratchDirs);

const PROCESS_TIMEOUT = 180_000;
const CLAUDE_SKILL = ".claude/skills/groot/SKILL.md";

async function json(root: string, args: readonly string[]) {
  const run = await runCli(root, [...args, "--json"]);
  return { ...run, envelope: ResultEnvelope.parse(JSON.parse(run.stdout)) };
}

const contextPaths = (root: string): string[] =>
  (JSON.parse(readFileSync(join(root, "groot.lock.json"), "utf8")) as GrootLock).context.map(
    (entry) => entry.path,
  );

describe("groot context sync (process-level)", () => {
  test(
    "--skip-conflicts reports a skipped hand edit and keeps its ownership record",
    async () => {
      // Arrange — a synced project whose Claude skill was then edited by hand.
      const root = registeredProject(["api"]);
      const synced = await json(root, ["context", "sync"]);
      expect(synced.exitCode).toBe(0);
      const owned = contextPaths(root);
      appendFileSync(join(root, CLAUDE_SKILL), "\n# my notes\n");

      // Act
      const skipped = await json(root, ["context", "sync", "--skip-conflicts"]);
      const human = await runCli(root, ["context", "sync", "--skip-conflicts"]);

      // Assert
      expect(skipped.exitCode).toBe(0);
      const data = skipped.envelope.data as { plan: { actions: unknown[] }; applied: unknown };
      expect(data.plan.actions).toEqual([]);
      expect(data.applied).toBeNull();
      expect(skipped.envelope.warnings).toEqual([
        expect.stringContaining(`skipped ${CLAUDE_SKILL}: `),
      ]);
      expect(contextPaths(root)).toEqual(owned);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("in sync except 1 skipped conflict");
      expect(human.stdout).not.toContain("already in sync");
      expect(human.stderr).toContain(`skipped ${CLAUDE_SKILL}`);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a policy that refuses sync's classes returns the saved plan blocked, resolved with groot apply",
    async () => {
      // Arrange — fs.create (new instruction files) is not allowed.
      const root = registeredProject(["api"], {
        policy: { allow: ["fs.edit", "fs.delete", "fs.move", "deps.change"], external: "deny" },
      });

      // Act
      const denied = await json(root, ["context", "sync"]);
      const planId = String(denied.envelope.refs.planId);
      const resolved = await json(root, ["apply", planId, "--allow", "fs.create"]);

      // Assert
      expect(denied.exitCode).toBe(7);
      expect(denied.envelope.error?.id).toBe("GROOT_E_POLICY_DENIED");
      expect(planId).toMatch(/^plan_/);
      expect(denied.envelope.blocked.map((decision) => decision.resolveWith)).toEqual([
        `groot apply ${planId} --allow fs.create`,
      ]);
      expect(resolved.exitCode).toBe(0);
      expect(contextPaths(root)).toContain("AGENTS.md");
    },
    PROCESS_TIMEOUT,
  );
});
