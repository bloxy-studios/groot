/**
 * Test support for process-level CLI/MCP tests (never imported by runtime
 * code): a v2-registered Bun workspace of create-hono apps under apps/ —
 * enough for the real core to discover, plan, and verify, with no generators
 * and no installs (no groot.lock.json, so lock defaults apply) — plus
 * contract-valid evidence and verification-report fixtures.
 */
import type { BlueprintV2 } from "../core/contracts/blueprint.ts";
import { type EnvironmentInfo, type RevisionInfo, schemaUrl } from "../core/contracts/common.ts";
import type { Evidence, ProfileSummary, VerificationReport } from "../core/contracts/evidence.ts";
import { scratchProject } from "../core/executor/test-support.ts";
import { newId } from "../core/ids.ts";
import { CREATE_HONO_INDEX, createHonoPackage } from "../core/recipes/testing/projects.ts";
import { appFixture, blueprintFixture } from "../core/test-fixtures.ts";

export function registeredProject(
  apps: readonly string[],
  blueprint: Partial<BlueprintV2> = {},
  files: Readonly<Record<string, string>> = {},
): string {
  const doc = blueprintFixture({
    apps: apps.map((id) => appFixture({ id, path: `apps/${id}` })),
    ...blueprint,
  });
  const appFiles = Object.fromEntries(
    apps.flatMap((id) => [
      [`apps/${id}/package.json`, createHonoPackage(id)],
      [`apps/${id}/src/index.ts`, CREATE_HONO_INDEX],
    ]),
  );
  return scratchProject(
    {
      "package.json": `${JSON.stringify({ name: "fixture", private: true, workspaces: ["apps/*"] }, null, 2)}\n`,
      "groot.json": `${JSON.stringify(doc, null, 2)}\n`,
      ...appFiles,
      ...files,
    },
    "groot-cli-",
  );
}

const REVISION: RevisionInfo = {
  vcs: "none",
  head: null,
  branch: null,
  dirty: false,
  worktreeFingerprint: null,
};
const ENVIRONMENT: EnvironmentInfo = {
  os: "test",
  arch: "test",
  bun: "test",
  groot: "test",
  ci: true,
};

export function evidenceFixture(
  check: string,
  status: Evidence["status"],
  extra: Partial<Evidence> = {},
): Evidence {
  return {
    $schema: schemaUrl("evidence"),
    schemaVersion: 1,
    kind: "groot.evidence",
    id: newId("ev"),
    check,
    title: check,
    profile: "build",
    status,
    scope: { capability: null, unit: null, operationId: null, taskId: null },
    method: { kind: "static", tool: "test", command: null },
    revision: { ...REVISION },
    environment: { ...ENVIRONMENT },
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T00:00:01.000Z",
    durationMs: 1000,
    summary: `${check} ${status}`,
    details: {},
    artifacts: [],
    limitations: [],
    reason: null,
    nextStep: null,
    simulated: false,
    ...extra,
  };
}

export function verificationReportFixture(
  evidence: Evidence[],
  interrupted = false,
): VerificationReport {
  const none: ProfileSummary = { status: "not-run", pass: 0, fail: 0, skipped: 0, blocked: 0 };
  return {
    $schema: schemaUrl("verification"),
    schemaVersion: 1,
    kind: "groot.verification",
    root: "/tmp/fixture",
    revision: { ...REVISION },
    environment: { ...ENVIRONMENT },
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T00:00:01.000Z",
    scope: { capability: null, profiles: ["build"] },
    profiles: { structural: none, build: none, runtime: none, "product-flow": none },
    evidence,
    ok: !interrupted && evidence.every((entry) => entry.status !== "fail"),
    interrupted,
  };
}
