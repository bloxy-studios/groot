/**
 * Evidence store: every field of a stored record is redacted (not only the
 * artifacts), and ids are validated before they become paths.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "../contracts/common.ts";
import type { Evidence } from "../contracts/evidence.ts";
import { GrootV2Error } from "../errors.ts";
import { prettyJson } from "../json.ts";
import { readEvidence, storeEvidence } from "./store.ts";

const ID = "ev_0000000000000000000001";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "groot-evidence-")));
}

function evidenceInput(overrides: Partial<Evidence> = {}): Omit<Evidence, "artifacts"> {
  const at = "2026-10-08T00:00:00.000Z";
  return {
    $schema: schemaUrl("evidence"),
    schemaVersion: 1,
    kind: "groot.evidence",
    id: ID,
    check: "build.build",
    title: "build",
    profile: "build",
    status: "fail",
    scope: { capability: null, unit: "apps/api", operationId: null, taskId: null },
    method: { kind: "command", tool: "build.build", command: null },
    revision: { vcs: "none", head: null, branch: null, dirty: false, worktreeFingerprint: null },
    environment: { os: "darwin", arch: "arm64", bun: "1.4.0", groot: "2.0.0", ci: false },
    startedAt: at,
    finishedAt: at,
    durationMs: 1,
    summary: "ok",
    details: {},
    limitations: [],
    reason: null,
    nextStep: null,
    simulated: false,
    ...overrides,
  };
}

describe("storeEvidence", () => {
  test("redacts the whole record, not only the artifacts", async () => {
    // Arrange
    const root = scratch();
    const known = "known-secret-value-42";
    const input = evidenceInput({
      summary: "bun run build failed in apps/api (exit 1): STRIPE_SECRET_KEY=rk_live_51Hxyzxyzxyz",
      details: { tail: `token=${known}`, nested: ["PASSWORD=hunter2"] },
      limitations: ["API_KEY=abc123456 was printed"],
      reason: `saw ${known}`,
      nextStep: "rotate postgres://app:hunter2@db/app",
    });

    // Act
    const stored = storeEvidence(root, input, [], [known]);

    // Assert
    const onDisk = readFileSync(join(root, ".groot/evidence", ID, "evidence.json"), "utf8");
    for (const leaked of ["rk_live_51Hxyzxyzxyz", known, "hunter2", "abc123456"]) {
      expect(onDisk).not.toContain(leaked);
      expect(JSON.stringify(stored)).not.toContain(leaked);
    }
    expect(stored.summary).toBe(
      "bun run build failed in apps/api (exit 1): STRIPE_SECRET_KEY=[REDACTED]",
    );
    expect((await readEvidence(root, ID)).summary).toBe(stored.summary);
  });

  test("refuses an artifact name that is not a single file name, before writing anything", () => {
    // Arrange
    const base = scratch();
    const root = join(base, "project");
    mkdirSync(root);
    const names = ["../../../../escaped.log", "nested/server.log", "..", ".", "", "evidence.json"];

    // Act
    const ids = names.map((name) => {
      try {
        storeEvidence(root, evidenceInput(), [
          { name: "server.log", kind: "log", content: "fine" },
          { name, kind: "log", content: "escaped" },
        ]);
      } catch (error) {
        return error instanceof GrootV2Error ? error.id : String(error);
      }
      return "stored";
    });

    // Assert
    expect(ids).toEqual(names.map(() => "GROOT_E_PATH_OUTSIDE_PROJECT"));
    expect(existsSync(join(base, "escaped.log"))).toBe(false);
    expect(existsSync(join(root, ".groot/evidence", ID))).toBe(false);
  });
});

describe("readEvidence", () => {
  test("refuses an id that is not an evidence id instead of reading outside .groot", async () => {
    // Arrange: a well-formed evidence file that `../` traversal would reach.
    const root = scratch();
    mkdirSync(join(root, ".groot/evidence"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(
      join(root, "elsewhere/evidence.json"),
      prettyJson({ ...evidenceInput(), artifacts: [] }),
    );

    // Act
    const error = await readEvidence(root, "../../elsewhere").then(
      () => null,
      (caught: unknown) => caught,
    );

    // Assert
    expect(error).toBeInstanceOf(GrootV2Error);
    expect((error as GrootV2Error).id).toBe("GROOT_E_NOT_FOUND");
  });
});
