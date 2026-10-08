/**
 * Process-level tests for `groot migrate`: the dry run previews the v1 → v2
 * plan as one envelope without touching groot.json; non-v1 projects are
 * refused with GROOT_E_USAGE. The apply path runs only once core/executor is
 * integrated (skipped until then, same probe as the adopt tests).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintV2 } from "../core/contracts/blueprint.ts";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { OperationPlan } from "../core/contracts/plan.ts";
import {
  bunMonorepo,
  json,
  runCli,
  V1_MANIFEST,
  v1Workspace,
} from "../core/discovery/test-projects.ts";
import { GrootV2Error } from "../core/errors.ts";
import { savePlan } from "../core/executor/index.ts";
import { planMigrate } from "../core/planner/migrate.ts";
import { createContext } from "../core/runtime.ts";

const TIMEOUT = 90_000;

async function executorIntegrated(): Promise<boolean> {
  const root = v1Workspace();
  const plan = await planMigrate(createContext({ cwd: root }), ".");
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

describe("groot migrate (process-level)", () => {
  test(
    "<v1 workspace> --dry-run --json → exit 0, the migrate plan, groot.json untouched",
    async () => {
      // Arrange
      const root = v1Workspace();
      const original = readFileSync(join(root, "groot.json"), "utf8");

      // Act
      const run = await runCli(root, ["migrate", root, "--dry-run", "--json"]);

      // Assert
      expect(run.exitCode).toBe(0);
      const envelope = envelopeOf(run.stdout);
      expect(envelope).toMatchObject({ command: "migrate", ok: true });
      const plan = OperationPlan.parse(envelope.data);
      expect(plan.intent).toEqual({ type: "migrate", from: 1, to: 2 });
      const write = plan.actions.find(
        (action) => action.type === "file.write" && action.path === "groot.json",
      );
      const migrated = BlueprintV2.parse(
        JSON.parse(write?.type === "file.write" ? write.content : "{}"),
      );
      expect(migrated.scaffolds).toEqual(
        V1_MANIFEST.scaffolds as unknown as BlueprintV2["scaffolds"],
      );
      expect(readFileSync(join(root, "groot.json"), "utf8")).toBe(original);
    },
    TIMEOUT,
  );

  test(
    "a project without a v1 groot.json → exit 2, GROOT_E_USAGE explaining the state",
    async () => {
      // Arrange
      const unregistered = bunMonorepo();
      const newer = bunMonorepo({ "groot.json": json({ version: 3 }) });

      // Act
      const first = await runCli(unregistered, ["migrate", "--json"]);
      const second = await runCli(newer, ["migrate", "--dry-run", "--json"]);

      // Assert
      expect(first.exitCode).toBe(2);
      expect(envelopeOf(first.stdout).error).toMatchObject({ id: "GROOT_E_USAGE" });
      expect(envelopeOf(first.stdout).error?.message).toContain("nothing to migrate");
      expect(second.exitCode).toBe(2);
      expect(envelopeOf(second.stdout).error?.message).toContain("does not read");
    },
    TIMEOUT,
  );

  test.skipIf(!EXECUTOR_INTEGRATED)(
    "applies the migration: groot.json becomes version 2 with the v1 fields verbatim — skipped until core/executor is integrated",
    async () => {
      // Arrange
      const root = v1Workspace();

      // Act
      const run = await runCli(root, ["migrate", root, "--json"]);

      // Assert
      expect(run.exitCode).toBe(0);
      const doc = BlueprintV2.parse(JSON.parse(readFileSync(join(root, "groot.json"), "utf8")));
      expect(doc.version).toBe(2);
      expect(doc.scaffolds).toEqual(V1_MANIFEST.scaffolds as unknown as BlueprintV2["scaffolds"]);
      expect(doc.project.origin).toBe("migrated");
    },
    TIMEOUT,
  );
});
