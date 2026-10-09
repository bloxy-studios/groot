/**
 * `groot verify` exit mapping and interruption: an interrupted run exits 130
 * with GROOT_E_INTERRUPTED and a partial, never-ok report (process-level, a
 * real SIGINT); otherwise a failed check → 5, a blocked check → 7 with one
 * decision per blocked check, else 0.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidenceFixture as evidence,
  registeredProject,
  verificationReportFixture as report,
} from "../cli/test-support.ts";
import { ResultEnvelope } from "../core/contracts/envelope.ts";
import type { VerificationReport } from "../core/contracts/evidence.ts";
import { spawnCli, waitFor } from "../core/executor/test-support.ts";
import { appFixture } from "../core/test-fixtures.ts";
import { verifyResult } from "./verify.ts";

const PROCESS_TIMEOUT = 180_000;

describe("groot verify exit mapping", () => {
  const credential = evidence("runtime.provider", "blocked", {
    reason: "credential not set: PROVIDER_TOKEN",
    nextStep: "Set PROVIDER_TOKEN (or export it in the environment), then re-run groot verify.",
    details: { missingCredentials: ["PROVIDER_TOKEN"] },
  });

  test("interrupted wins: exit 130 with GROOT_E_INTERRUPTED and the partial report", () => {
    const partial = report(
      [evidence("a", "fail"), evidence("b", "skipped", { reason: "cancelled" })],
      true,
    );
    const result = verifyResult(partial);
    expect(result).toMatchObject({ ok: false, exitCode: 130, data: partial });
    expect(result.error?.id).toBe("GROOT_E_INTERRUPTED");
  });

  test("failed → 5; blocked → 7 with one decision per blocked check; otherwise 0", () => {
    expect(verifyResult(report([evidence("a", "fail"), credential])).exitCode).toBe(5);

    const blocked = verifyResult(report([evidence("a", "pass"), credential]));
    expect(blocked).toMatchObject({ ok: false, exitCode: 7 });
    expect(blocked.blocked).toEqual([
      {
        id: "verify.runtime.provider",
        kind: "credential",
        question: "runtime.provider is blocked: credential not set: PROVIDER_TOKEN",
        options: [],
        resolveWith: credential.nextStep as string,
      },
    ]);

    const passed = verifyResult(report([evidence("a", "pass"), evidence("b", "skipped")]));
    expect(passed).toMatchObject({ ok: true, exitCode: 0, blocked: [] });
  });
});

describe("groot verify --unit (process-level)", () => {
  test(
    "runs one app's checks plus the project-wide ones; a path that is no app is a usage error",
    async () => {
      // Arrange
      const root = registeredProject(["a", "b"], {
        apps: [
          appFixture({ id: "a", path: "apps/a", port: 3001 }),
          appFixture({ id: "b", path: "apps/b", port: 3002 }),
        ],
      });

      // Act
      const scoped = spawnCli(root, [
        "verify",
        "--unit",
        "./apps/a/",
        "--profile",
        "structural",
        "--json",
      ]);
      const unknown = spawnCli(root, ["verify", "--unit", "apps/zzz", "--json"]);
      const [run, refused] = await Promise.all([scoped.done, unknown.done]);

      // Assert
      expect(run.exitCode).toBe(0);
      const report = ResultEnvelope.parse(JSON.parse(run.stdout)).data as VerificationReport;
      const checks = report.evidence.map((entry) => entry.check);
      expect(checks).toContain("structural.package.a");
      expect(checks).toContain("structural.blueprint");
      expect(checks).not.toContain("structural.package.b");
      expect(refused.exitCode).toBe(2);
      const envelope = ResultEnvelope.parse(JSON.parse(refused.stdout));
      expect(envelope.error?.id).toBe("GROOT_E_USAGE");
      expect(envelope.error?.message).toContain("apps/zzz");
      expect(envelope.error?.hint).toContain("apps/a, apps/b");
    },
    PROCESS_TIMEOUT,
  );
});

describe.skipIf(process.platform === "win32")("SIGINT during verification (process-level)", () => {
  test(
    "exits 130 with GROOT_E_INTERRUPTED; unfinished checks are cancelled, never failed",
    async () => {
      // Arrange — the typecheck script marks that it started, then blocks.
      const marker = join(mkdtempSync(join(tmpdir(), "groot-verify-sigint-")), "started");
      const root = registeredProject(
        ["api"],
        {},
        {
          "apps/api/package.json": `${JSON.stringify(
            { name: "api", scripts: { typecheck: `touch '${marker}' && sleep 30` } },
            null,
            2,
          )}\n`,
        },
      );

      // Act
      const cli = spawnCli(root, ["verify", "--profile", "build", "--json"]);
      await waitFor(() => existsSync(marker), 120_000, "the typecheck script to start");
      cli.proc.kill("SIGINT");
      const run = await cli.done;

      // Assert
      expect(run.exitCode).toBe(130);
      const envelope = ResultEnvelope.parse(JSON.parse(run.stdout));
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.id).toBe("GROOT_E_INTERRUPTED");
      const partial = envelope.data as VerificationReport;
      expect(partial).toMatchObject({ interrupted: true, ok: false });
      expect(partial.profiles.build.status).not.toBe("pass");
      expect(partial.evidence.map((entry) => [entry.check, entry.status, entry.reason])).toEqual([
        ["build.typecheck.api", "skipped", "cancelled"],
        ["build.script.api", "skipped", "cancelled"],
      ]);
    },
    PROCESS_TIMEOUT,
  );
});
