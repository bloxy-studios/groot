/**
 * Process-level tests for `groot inspect` (the v2 machine contract): with
 * --json, stdout carries exactly one result envelope whose data is a valid
 * ProjectObservation; the exit code is 0 even for projects Groot can only
 * inspect; env values never reach stdout or stderr.
 */
import { describe, expect, test } from "bun:test";
import { normalizeArgv } from "../cli-compat.ts";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import { ProjectObservation } from "../core/contracts/project.ts";
import {
  customHonoApp,
  makeProject,
  pnpmWorkspace,
  runCli,
  SECRET_VALUES,
} from "../core/discovery/test-projects.ts";

const TIMEOUT = 90_000;

/** stdout must be exactly one JSON document — the envelope. */
function envelopeOf(stdout: string): ResultEnvelope {
  return ResultEnvelope.parse(JSON.parse(stdout));
}

describe("groot inspect (process-level)", () => {
  test(
    "<fixture> --json → exit 0, one envelope, data is the observation, no secret values",
    async () => {
      // Arrange
      const root = await customHonoApp();

      // Act
      const run = await runCli(root, ["inspect", root, "--json"]);

      // Assert
      expect(run.exitCode).toBe(0);
      const envelope = envelopeOf(run.stdout);
      expect(envelope).toMatchObject({
        kind: "groot.result",
        command: "inspect",
        ok: true,
        error: null,
      });
      const observation = ProjectObservation.parse(envelope.data);
      expect(observation.root).toBe(root);
      expect(observation.support.level).toBe("certified");
      for (const secret of SECRET_VALUES) {
        expect(run.stdout).not.toContain(secret);
        expect(run.stderr).not.toContain(secret);
      }
    },
    TIMEOUT,
  );

  test(
    "inspect-only and unsupported projects still exit 0 (support is data, not failure)",
    async () => {
      // Arrange
      const pnpm = pnpmWorkspace();
      const scratch = makeProject({});

      // Act
      const inspectOnly = await runCli(pnpm, ["inspect", "--json"]);
      const missing = await runCli(scratch, ["inspect", "no/such/dir", "--json"]);

      // Assert
      expect(inspectOnly.exitCode).toBe(0);
      expect(ProjectObservation.parse(envelopeOf(inspectOnly.stdout).data).support.level).toBe(
        "inspect-only",
      );
      expect(missing.exitCode).toBe(0);
      expect(ProjectObservation.parse(envelopeOf(missing.stdout).data).support.level).toBe(
        "unsupported",
      );
    },
    TIMEOUT,
  );

  test(
    "human report: compact facts on stdout, env names but never values",
    async () => {
      // Arrange
      const root = await customHonoApp();

      // Act
      const run = await runCli(root, ["inspect"]);

      // Assert
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("groot inspect");
      expect(run.stdout).toContain("certified");
      expect(run.stdout).toContain("entry server/main.ts");
      expect(run.stdout).toContain("API_SECRET");
      for (const secret of SECRET_VALUES) expect(run.stdout).not.toContain(secret);
    },
    TIMEOUT,
  );

  test("inspect, adopt, and migrate are subcommands, not bun-create destinations", () => {
    // Arrange / Act / Assert
    expect(normalizeArgv(["inspect", "."])).toEqual(["inspect", "."]);
    expect(normalizeArgv(["adopt", "--dry-run"])).toEqual(["adopt", "--dry-run"]);
    expect(normalizeArgv(["migrate"])).toEqual(["migrate"]);
    expect(normalizeArgv(["my-app"])).toEqual(["init", "my-app"]);
  });
});
