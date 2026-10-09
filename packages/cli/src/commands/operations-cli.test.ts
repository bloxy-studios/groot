/**
 * Process-level tests for `groot apply/status/rollback` (piped stdio, the
 * CI/agent environment): JSON envelopes, policy denials as blocked decisions
 * with --allow collected from raw args, policy loading that fails closed on
 * an invalid groot.json, resume re-checking the policy, saved-plan ids,
 * writer-lock contention between two real processes, rollback conflicts
 * (exit 6), and that a generated secret never appears in output or under .groot/.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeArgv } from "../cli-compat.ts";
import { savePlan } from "../core/executor/index.ts";
import {
  addCommand,
  addDeps,
  anyFileContains,
  buildPlan,
  envelopeOf,
  MULTI_STEP_FILES,
  multiStepPlan,
  operationIds,
  removeScratchDirs,
  runCli,
  scratchProject,
  snapshot,
  spawnCli,
  writePlanFile,
} from "../core/executor/test-support.ts";
import { blueprintFixture } from "../core/test-fixtures.ts";
import { parseAllowFlags } from "./apply.ts";

afterAll(removeScratchDirs);

const PROCESS_TIMEOUT = 120_000;

const FILES_ONLY = { allow: ["fs.create" as const, "fs.edit" as const], external: "deny" as const };

describe("--allow parsing (citty keeps only the last repeated value)", () => {
  test("collects repeated flags, = forms, and comma lists, de-duplicated", () => {
    // Arrange
    const raw = [
      "plan.json",
      "--allow",
      "command",
      "--allow=deps.change,fs.delete",
      "--allow",
      "command",
    ];

    // Act
    const classes = parseAllowFlags(raw);

    // Assert
    expect(classes).toEqual(["command", "deps.change", "fs.delete"]);
  });

  test("rejects unknown classes and a dangling flag", () => {
    expect(() => parseAllowFlags(["--allow", "everything"])).toThrow(/not an action class/);
    expect(() => parseAllowFlags(["plan.json", "--allow"])).toThrow(/needs an action class/);
  });

  test("the new commands are routed as commands, not bun-create destinations", () => {
    for (const command of ["apply", "resume", "rollback", "status"]) {
      expect(normalizeArgv([command, "x"])).toEqual([command, "x"]);
    }
  });
});

describe("groot apply / status (process-level)", () => {
  test(
    "apply --json prints one result envelope; status lists and shows the operation",
    async () => {
      // Arrange
      const root = scratchProject(MULTI_STEP_FILES);
      const planFile = writePlanFile(await multiStepPlan(root));

      // Act
      const applied = await runCli(root, ["apply", planFile, "--json"]);
      const listed = await runCli(root, ["status", "--json"]);
      const operationId = String(envelopeOf(applied).refs.operationId);
      const shown = await runCli(root, ["status", operationId, "--json"]);

      // Assert
      expect(applied.exitCode).toBe(0);
      const result = envelopeOf(applied);
      expect(result.ok).toBe(true);
      expect(result.data.kind).toBe("groot.operation-result");
      expect(result.data.status).toBe("completed");
      expect(listed.exitCode).toBe(0);
      const operations = envelopeOf(listed).data.operations as Record<string, unknown>[];
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        id: operationId,
        status: "completed",
        intent: "context-sync",
        steps: { done: 7, total: 7 },
        resumable: false,
      });
      expect(envelopeOf(listed).data.lock).toBeNull();
      expect((envelopeOf(shown).data.operation as { status: string }).status).toBe("completed");
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a saved plan applies by its id",
    async () => {
      // Arrange
      const root = scratchProject();
      const plan = await buildPlan(root, async (b) => {
        await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
      });
      await savePlan(root, plan);

      // Act
      const run = await runCli(root, ["apply", plan.planId]);

      // Assert
      expect(run.exitCode).toBe(0);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
      expect(run.stdout).toContain("Applied");
    },
    PROCESS_TIMEOUT,
  );

  test(
    "a policy denial is a blocked decision per class (exit 7); --allow resolves it",
    async () => {
      // Arrange
      const root = scratchProject({ "package.json": '{\n  "name": "demo"\n}\n' });
      const blueprint = blueprintFixture({
        policy: { allow: ["fs.create", "fs.edit"], external: "deny" },
      });
      writeFileSync(join(root, "groot.json"), `${JSON.stringify(blueprint, null, 2)}\n`);
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
          addCommand(b, "true");
        }),
      );

      // Act
      const denied = await runCli(root, ["apply", planFile, "--json"]);
      const operationsAfterDenial = operationIds(root);
      const bogus = await runCli(root, ["apply", planFile, "--allow", "everything"]);
      const allowed = await runCli(root, [
        "apply",
        planFile,
        "--allow",
        "command",
        "--allow",
        "deps.change",
        "--json",
      ]);

      // Assert
      expect(denied.exitCode).toBe(7);
      const envelope = envelopeOf(denied);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.id).toBe("GROOT_E_POLICY_DENIED");
      expect(envelope.blocked.map((decision) => decision.id)).toEqual([
        "policy.command",
        "policy.deps.change",
      ]);
      expect(envelope.blocked[0]?.resolveWith).toBe(`groot apply ${planFile} --allow command`);
      expect(operationsAfterDenial).toEqual([]);
      expect(bogus.exitCode).toBe(2);
      expect(allowed.exitCode).toBe(0);
      expect(envelopeOf(allowed).ok).toBe(true);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "comma-listed approvals work too",
    async () => {
      // Arrange
      const root = scratchProject({ "package.json": '{\n  "name": "demo"\n}\n' });
      const blueprint = blueprintFixture({
        policy: { allow: ["fs.create", "fs.edit"], external: "deny" },
      });
      writeFileSync(join(root, "groot.json"), `${JSON.stringify(blueprint, null, 2)}\n`);
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
          addCommand(b, "true");
        }),
      );

      // Act
      const run = await runCli(root, ["apply", planFile, "--allow=command,deps.change"]);

      // Assert
      expect(run.exitCode).toBe(0);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "an invalid groot.json fails closed: nothing is applied under a default policy",
    async () => {
      // Arrange — a restrictive policy next to one unrelated invalid field.
      const root = scratchProject({ "package.json": '{\n  "name": "demo"\n}\n' });
      const blueprint = blueprintFixture({ policy: FILES_ONLY });
      writeFileSync(
        join(root, "groot.json"),
        `${JSON.stringify({ ...blueprint, project: { ...blueprint.project, packageManager: "pnpm" } }, null, 2)}\n`,
      );
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          addCommand(b, "echo ran > ran.txt");
        }),
      );

      // Act
      const run = await runCli(root, ["apply", planFile, "--json"]);

      // Assert
      expect(run.exitCode).toBe(2);
      expect(envelopeOf(run).error?.id).toBe("GROOT_E_INVALID_DOCUMENT");
      expect(existsSync(join(root, "ran.txt"))).toBe(false);
      expect(operationIds(root)).toEqual([]);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "resume re-checks the policy: approvals don't carry over, --allow on resume resolves it",
    async () => {
      // Arrange — apply (approved) crashes right after the command step's intent.
      const root = scratchProject();
      writeFileSync(
        join(root, "groot.json"),
        `${JSON.stringify(blueprintFixture({ policy: FILES_ONLY }), null, 2)}\n`,
      );
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          await b.writeFile({ path: "a.txt", content: "a\n", description: "create a.txt" });
          addCommand(b, "echo ran > ran.txt", { idempotent: true });
        }),
      );
      const crashed = await runCli(root, ["apply", planFile, "--allow", "command"], {
        GROOT_INTERNAL_CRASH_AT: "s02:after-intent",
      });
      const operationId = String(operationIds(root)[0]);

      // Act
      const denied = await runCli(root, ["resume", operationId, "--json"]);
      const allowed = await runCli(root, ["resume", operationId, "--allow", "command", "--json"]);

      // Assert
      expect(crashed.signalCode).toBe("SIGKILL");
      expect(denied.exitCode).toBe(7);
      const envelope = envelopeOf(denied);
      expect(envelope.error?.id).toBe("GROOT_E_POLICY_DENIED");
      expect(envelope.blocked.map((decision) => decision.resolveWith)).toEqual([
        `groot resume ${operationId} --allow command`,
      ]);
      expect(allowed.exitCode).toBe(0);
      expect(readFileSync(join(root, "ran.txt"), "utf8")).toBe("ran\n");
    },
    PROCESS_TIMEOUT,
  );

  test(
    "rollback holds its compensating install to the policy: blocked per class (exit 7), --allow resolves it",
    async () => {
      // Arrange — the policy allows the dependency edit, but no install, process, or network.
      const original = '{\n  "name": "demo",\n  "private": true\n}\n';
      const root = scratchProject({ "package.json": original });
      writeFileSync(
        join(root, "groot.json"),
        `${JSON.stringify(blueprintFixture({ policy: { allow: ["fs.edit", "deps.change"], external: "deny" } }), null, 2)}\n`,
      );
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          await addDeps(b, [{ package: "left-pad", to: "1.3.0", dev: false }]);
        }),
      );
      const applied = await runCli(root, ["apply", planFile, "--json"]);
      const operationId = String(envelopeOf(applied).refs.operationId);
      const appliedPackage = readFileSync(join(root, "package.json"), "utf8");

      // Act
      const denied = await runCli(root, ["rollback", operationId, "--json"]);
      const packageAfterDenial = readFileSync(join(root, "package.json"), "utf8");
      const allowed = await runCli(root, [
        "rollback",
        operationId,
        "--allow",
        "command,install,network",
        "--json",
      ]);

      // Assert
      expect(applied.exitCode).toBe(0);
      expect(denied.exitCode).toBe(7);
      const envelope = envelopeOf(denied);
      expect(envelope.error?.id).toBe("GROOT_E_POLICY_DENIED");
      expect(envelope.refs.operationId).toBe(operationId);
      expect(envelope.blocked.map((decision) => decision.resolveWith)).toEqual([
        `groot rollback ${operationId} --allow command`,
        `groot rollback ${operationId} --allow install`,
        `groot rollback ${operationId} --allow network`,
      ]);
      expect(packageAfterDenial).toBe(appliedPackage);
      expect(allowed.exitCode).toBe(0);
      expect(envelopeOf(allowed).data.status).toBe("rolled-back");
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
    },
    PROCESS_TIMEOUT,
  );

  test(
    "two concurrent applies on one project: one wins, the other exits 8 (locked)",
    async () => {
      // Arrange
      const root = scratchProject();
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          addCommand(b, "sleep 6", { description: "hold the lock for a while" });
          await b.writeFile({
            path: "done.txt",
            content: "done\n",
            description: "create done.txt",
          });
        }),
      );

      // Act
      const first = spawnCli(root, ["apply", planFile, "--json"]);
      const second = spawnCli(root, ["apply", planFile, "--json"]);
      const runs = await Promise.all([first.done, second.done]);

      // Assert
      expect(runs.map((run) => run.exitCode).sort()).toEqual([0, 8]);
      const loser = runs.find((run) => run.exitCode === 8);
      expect(loser === undefined ? null : envelopeOf(loser).error?.id).toBe("GROOT_E_LOCKED");
      expect(operationIds(root)).toHaveLength(1);
      expect(readFileSync(join(root, "done.txt"), "utf8")).toBe("done\n");
    },
    PROCESS_TIMEOUT,
  );

  test(
    "status outside any project is a usage error",
    async () => {
      // Arrange
      const dir = scratchProject();

      // Act
      const run = await runCli(dir, ["status", "--json"]);

      // Assert
      expect(run.exitCode).toBe(2);
      expect(envelopeOf(run).error?.id).toBe("GROOT_E_NOT_A_PROJECT");
    },
    PROCESS_TIMEOUT,
  );
});

describe("secret hygiene and rollback conflicts (process-level)", () => {
  test(
    "the generated secret never appears in CLI output or anywhere under .groot",
    async () => {
      // Arrange
      const root = scratchProject(MULTI_STEP_FILES);
      const planFile = writePlanFile(await multiStepPlan(root));

      // Act
      const applied = await runCli(root, ["apply", planFile, "--json", "--events"]);
      const operationId = String(envelopeOf(applied).refs.operationId);
      const human = await runCli(root, ["status", operationId]);
      const preview = await runCli(root, ["rollback", operationId, "--dry-run", "--json"]);
      const secret =
        /APP_SECRET=(\S+)/.exec(readFileSync(join(root, ".env.local"), "utf8"))?.[1] ?? "";

      // Assert
      expect(applied.exitCode).toBe(0);
      expect(secret).toHaveLength(43);
      for (const run of [applied, human, preview]) {
        expect(run.stdout).not.toContain(secret);
        expect(run.stderr).not.toContain(secret);
      }
      expect(anyFileContains(join(root, ".groot"), secret)).toBeNull();
    },
    PROCESS_TIMEOUT,
  );

  test(
    "rollback after a human edit: the preview names exactly that file, execution exits 6 changing nothing",
    async () => {
      // Arrange
      const root = scratchProject({ "README.md": "# Demo\n" });
      const before = snapshot(root);
      const planFile = writePlanFile(
        await buildPlan(root, async (b) => {
          await b.writeFile({
            path: "src/new.ts",
            content: "export {};\n",
            description: "create src/new.ts",
          });
          await b.editFile({
            path: "README.md",
            edit: { kind: "lines", lines: ["Managed."], header: null },
            description: "edit README.md",
            owns: [],
            createIfMissing: false,
          });
        }),
      );
      const applied = await runCli(root, ["apply", planFile, "--json"]);
      const operationId = String(envelopeOf(applied).refs.operationId);
      const appliedReadme = readFileSync(join(root, "README.md"), "utf8");
      writeFileSync(join(root, "README.md"), `${appliedReadme}A human line.\n`);
      const edited = snapshot(root);

      // Act
      const preview = await runCli(root, ["rollback", operationId, "--dry-run", "--json"]);
      const refused = await runCli(root, ["rollback", operationId, "--json"]);
      const afterRefusal = snapshot(root);
      writeFileSync(join(root, "README.md"), appliedReadme);
      const rolledBack = await runCli(root, ["rollback", operationId]);

      // Assert
      expect(preview.exitCode).toBe(0);
      expect(envelopeOf(preview).data.possible).toBe(false);
      expect(envelopeOf(preview).data.conflicts).toEqual(["README.md"]);
      expect(refused.exitCode).toBe(6);
      expect(envelopeOf(refused).error?.id).toBe("GROOT_E_ROLLBACK_CONFLICT");
      expect(afterRefusal).toEqual(edited);
      expect(rolledBack.exitCode).toBe(0);
      expect(snapshot(root)).toEqual(before);
    },
    PROCESS_TIMEOUT,
  );
});
