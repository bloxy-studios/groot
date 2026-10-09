/**
 * Process-level tests for `groot adopt`: the dry run prints (and, once the
 * executor is integrated, saves) the plan as one envelope; refusals carry
 * stable error ids and exit 2. Apply-path tests run only when core/executor
 * is integrated — until then its stub throws "… is not integrated yet" and
 * they are skipped (see EXECUTOR_PENDING_REASON).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { BlueprintV2 } from "../core/contracts/blueprint.ts";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { OperationPlan } from "../core/contracts/plan.ts";
import {
  bunMonorepo,
  customHonoApp,
  git,
  pnpmWorkspace,
  runCli,
  SECRET_VALUES,
  v1Workspace,
} from "../core/discovery/test-projects.ts";
import { GrootV2Error } from "../core/errors.ts";
import { savePlan } from "../core/executor/index.ts";
import { planAdopt } from "../core/planner/adopt.ts";
import { createContext } from "../core/runtime.ts";

const TIMEOUT = 90_000;

const EXECUTOR_PENDING_REASON =
  "skipped until core/executor is integrated (applyPlan/savePlan still throw 'not integrated')";

/** Probe the executor once: its pre-integration stub rejects every call with "not integrated". */
async function executorIntegrated(): Promise<boolean> {
  const root = bunMonorepo();
  const plan = await planAdopt(createContext({ cwd: root }), ".");
  try {
    await savePlan(root, plan);
    return true;
  } catch (error) {
    if (error instanceof GrootV2Error && /not integrated/.test(error.message)) return false;
    throw error;
  }
}

const EXECUTOR_INTEGRATED = await executorIntegrated();

function envelopeOf(stdout: string): ResultEnvelope {
  return ResultEnvelope.parse(JSON.parse(stdout));
}

describe("groot adopt --dry-run (process-level)", () => {
  test(
    "<fixture> --dry-run --json → exit 0, one envelope with the plan, nothing written to the project",
    async () => {
      // Arrange
      const root = await customHonoApp();

      // Act
      const run = await runCli(root, ["adopt", root, "--dry-run", "--json"]);

      // Assert
      expect(run.exitCode).toBe(0);
      const envelope = envelopeOf(run.stdout);
      expect(envelope).toMatchObject({ command: "adopt", ok: true, error: null });
      const plan = OperationPlan.parse(envelope.data);
      expect(envelope.refs.planId).toBe(plan.planId);
      expect(plan.intent).toEqual({ type: "adopt" });
      expect(plan.actions.map((action) => ("path" in action ? action.path : null))).toEqual([
        "groot.json",
        "groot.lock.json",
      ]);
      for (const secret of SECRET_VALUES) expect(run.stdout).not.toContain(secret);
      expect(existsSync(join(root, "groot.json"))).toBe(false);
      if (EXECUTOR_INTEGRATED) {
        expect(existsSync(join(root, ".groot/plans", `${plan.planId}.json`))).toBe(true);
      } else {
        expect(envelope.warnings.join("\n")).toContain("The plan was not saved");
      }
    },
    TIMEOUT,
  );

  test(
    "human dry run shows actions, the groot.json preview, ownership, assumptions, and recovery",
    async () => {
      // Arrange
      const root = bunMonorepo();

      // Act
      const run = await runCli(root, ["adopt", "--dry-run"]);

      // Assert
      expect(run.exitCode).toBe(0);
      for (const heading of [
        "actions",
        "preview: groot.json",
        "ownership",
        "assumptions",
        "recovery",
      ]) {
        expect(run.stdout).toContain(heading);
      }
      expect(run.stdout).toContain('"origin": "adopted"');
    },
    TIMEOUT,
  );
});

describe("groot adopt refusals (process-level)", () => {
  test(
    "pnpm workspace → exit 2, error.id GROOT_E_UNSUPPORTED_PROJECT with the next step",
    async () => {
      // Arrange
      const root = pnpmWorkspace();

      // Act
      const json = await runCli(root, ["adopt", root, "--json"]);
      const human = await runCli(root, ["adopt", root]);

      // Assert
      expect(json.exitCode).toBe(2);
      const envelope = envelopeOf(json.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.id).toBe("GROOT_E_UNSUPPORTED_PROJECT");
      expect(envelope.error?.exitCode).toBe(2);
      expect(String(envelope.error?.details?.nextStep)).toContain("bun install");
      expect(human.exitCode).toBe(2);
      expect(human.stdout).toBe("");
      expect(human.stderr).toContain("groot error:");
    },
    TIMEOUT,
  );

  test(
    "groot v1 workspace → exit 2, GROOT_E_MIGRATION_REQUIRED",
    async () => {
      // Arrange
      const root = v1Workspace();

      // Act
      const run = await runCli(root, ["adopt", "--dry-run", "--json"]);

      // Assert
      expect(run.exitCode).toBe(2);
      expect(envelopeOf(run.stdout).error?.id).toBe("GROOT_E_MIGRATION_REQUIRED");
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "a groot.json symlink that leads nowhere → exit 2 GROOT_E_INVALID_DOCUMENT, never a plan that can only go stale",
    async () => {
      // Arrange: the link resolves through a regular file (ENOTDIR); the executor would refuse to replace it.
      const root = bunMonorepo();
      symlinkSync("package.json/x", join(root, "groot.json"));

      // Act
      const run = await runCli(root, ["adopt", root, "--json"]);

      // Assert
      expect(run.exitCode).toBe(2);
      const error = envelopeOf(run.stdout).error;
      expect(error?.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(error?.message).toContain("is a symlink whose target does not exist (ENOTDIR)");
      expect(error?.hint).toContain("check its permissions, owner, and symlinks");
      expect(existsSync(join(root, "groot.lock.json"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("groot adopt (apply path)", () => {
  test.skipIf(!EXECUTOR_INTEGRATED)(
    `writes exactly groot.json + groot.lock.json and leaves dirty work untouched — ${EXECUTOR_PENDING_REASON}`,
    async () => {
      // Arrange
      const root = await customHonoApp();
      const before = await git(root, "status", "--porcelain=v1", "--untracked-files=all");

      // Act
      const run = await runCli(root, ["adopt", root, "--json"]);

      // Assert
      expect(run.exitCode).toBe(0);
      expect(envelopeOf(run.stdout).ok).toBe(true);
      const blueprint = BlueprintV2.parse(
        JSON.parse(readFileSync(join(root, "groot.json"), "utf8")),
      );
      expect(blueprint.apps[0]).toMatchObject({ path: ".", entry: "server/main.ts", port: 4310 });
      expect(existsSync(join(root, "groot.lock.json"))).toBe(true);
      const after = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
      const added = after
        .split("\n")
        .filter((line) => line !== "" && !before.split("\n").includes(line));
      expect(added.sort()).toEqual(["?? groot.json", "?? groot.lock.json"]);
    },
    TIMEOUT,
  );
});
