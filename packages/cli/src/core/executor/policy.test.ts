/**
 * Action policy and external effects. Only an explicit per-run approval
 * (`groot apply --allow external`, from a person at a terminal) can approve
 * effects on provider accounts. A groot.json whose policy.allow lists
 * "external" therefore approves nothing extra, and it is still a valid
 * blueprint: its policy is enforced as written, never swapped for the
 * permissive default.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintV2, DEFAULT_POLICY, type Policy } from "../contracts/blueprint.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { deniedClasses } from "./policy.ts";
import {
  addCommand,
  buildPlan,
  envelopeOf,
  operationIds,
  runCli,
  scratchProject,
  writePlanFile,
} from "./test-support.ts";

const PROCESS_TIMEOUT = 120_000;

/** Every local class, plus "external" listed as if it could be pre-approved. */
const LISTS_EXTERNAL: Policy = { allow: [...DEFAULT_POLICY.allow, "external"], external: "ask" };

describe("policy.allow listing external", () => {
  test("is a valid blueprint policy that never pre-approves external effects", async () => {
    // Arrange
    const root = scratchProject();
    const plan = await buildPlan(root, async (b) => {
      b.add({
        type: "external",
        provider: "example",
        effect: "create a database",
        idempotencyKey: "db-1",
        cost: "free",
        description: "create a hosted database",
        classes: ["external"],
        reversible: false,
        compensation: "delete the database in the provider console",
      });
    });

    // Act
    const parsed = BlueprintV2.safeParse(blueprintFixture({ policy: LISTS_EXTERNAL }));
    const withoutApproval = deniedClasses(plan, LISTS_EXTERNAL, []);
    const approvedForThisRun = deniedClasses(plan, LISTS_EXTERNAL, ["external"]);
    const policyDenies = deniedClasses(plan, { ...LISTS_EXTERNAL, external: "deny" }, ["external"]);

    // Assert
    expect(parsed.success).toBe(true);
    expect(withoutApproval).toEqual(["external"]);
    expect(approvedForThisRun).toEqual([]);
    expect(policyDenies).toEqual(["external"]);
  });

  test(
    "a restrictive groot.json policy that lists external is enforced, not replaced by the default",
    async () => {
      // Arrange
      const root = scratchProject({ "README.md": "# Demo\n" });
      const blueprint = blueprintFixture({
        policy: { allow: ["fs.create", "fs.edit", "external"], external: "ask" },
      });
      writeFileSync(join(root, "groot.json"), `${JSON.stringify(blueprint, null, 2)}\n`);
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          addCommand(b, "echo ran > ran.txt", { touches: ["ran.txt"] });
        }),
      );

      // Act
      const run = await runCli(root, ["apply", planFile, "--json"]);

      // Assert
      expect(run.exitCode).toBe(7);
      const envelope = envelopeOf(run);
      expect(envelope.error?.id).toBe("GROOT_E_POLICY_DENIED");
      expect(envelope.data.policySource).toBe("groot.json");
      expect(envelope.blocked.map((decision) => decision.id)).toEqual(["policy.command"]);
      expect(existsSync(join(root, "ran.txt"))).toBe(false);
      expect(operationIds(root)).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );
});
