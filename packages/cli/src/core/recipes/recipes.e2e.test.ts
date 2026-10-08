/**
 * Certification of data.drizzle-sqlite + auth.better-auth — network, the real
 * generator, real installs, real servers. Opt-in so CI stays offline:
 *
 *   GROOT_RECIPE_E2E=1 bun test src/core/recipes/recipes.e2e.test.ts
 *
 * Three projects: (a) a fresh single app from create-hono 0.19.5, (b) a Bun
 * workspace with apps/api from the same generator, (c) an adopted custom
 * layout (server/main.ts on port 4310, custom scripts, a human AGENTS.md, a
 * dirty working tree). Each is planned with the PlanBuilder, materialized,
 * installed, and verified with every profile; then drizzle-kit must see no
 * schema drift and (a) the Better Auth CLI must reproduce the shipped schema.
 *
 * GROOT_RECIPE_E2E_REPORT=<file> writes the evidence summary (ids, step
 * tables, timings); GROOT_RECIPE_E2E_KEEP=1 keeps the projects for inspection.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../contracts/evidence.ts";
import { sha256Of } from "../fs/hash.ts";
import { prettyJson } from "../json.ts";
import { runProcess, tail } from "../process.ts";
import { appFixture } from "../test-fixtures.ts";
import { removeRegion } from "../transforms/index.ts";
import { type CertificationCase, type CertificationResult, certify } from "./testing/certify.ts";
import { adoptedApp, adoptedMain } from "./testing/fixtures.ts";
import { ADOPTED_AGENTS, commitAll, writeWorkspaceRoot } from "./testing/projects.ts";

const e2e = process.env.GROOT_RECIPE_E2E === "1";
const TIMEOUT = 900_000;
const GENERATOR = "create-hono@0.19.5";
const RECIPE_CHECKS = [
  "data.structural.api",
  "auth.structural.api",
  "data.build.api",
  "auth.build.api",
  "data.runtime.api",
  "auth.runtime.api",
  "auth.flow.api",
];

const roots: string[] = [];
const summaries: unknown[] = [];

// Removing three installed projects (node_modules included) outlasts the default hook timeout.
const CLEANUP_TIMEOUT_MS = 300_000;

afterAll(() => {
  const reportPath = process.env.GROOT_RECIPE_E2E_REPORT;
  if (reportPath && summaries.length > 0) writeFileSync(reportPath, prettyJson(summaries));
  if (process.env.GROOT_RECIPE_E2E_KEEP === "1") return;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, CLEANUP_TIMEOUT_MS);

function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `groot-cert-${name}-`));
  roots.push(dir);
  return dir;
}

/**
 * The real generator, run from the parent with a relative name: given an
 * absolute target, create-hono 0.19.5 drops the leading "/" and writes the
 * project under its cwd instead (observed 2026-10-08).
 */
async function createHono(parent: string, name: string): Promise<string> {
  const result = await runProcess({
    argv: ["bunx", GENERATOR, name, "--template", "bun", "--pm", "bun"],
    cwd: parent,
    stdin: "n\n", // "install dependencies?" has no negative flag
    timeoutMs: 300_000,
  });
  const dir = join(parent, name);
  if (result.exitCode !== 0 || !existsSync(join(dir, "src/index.ts"))) {
    throw new Error(
      `${GENERATOR} failed (exit ${result.exitCode}): ${tail(`${result.stdout}\n${result.stderr}`, 8)}`,
    );
  }
  return dir;
}

async function bunRun(cwd: string, script: string): Promise<string> {
  const result = await runProcess({ argv: ["bun", "run", script], cwd, timeoutMs: 300_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`bun run ${script} failed: ${tail(output, 8)}`);
  return output;
}

function evidenceFiles(root: string, evidence: readonly Evidence[]): string {
  return evidence
    .flatMap((entry) => {
      const dir = join(root, ".groot/evidence", entry.id);
      return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"));
    })
    .join("\n");
}

async function portReleased(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

/** Every recipe check passes; Groot's default checks pass or skip with a reason; nothing leaks. */
async function expectCertified(c: CertificationCase, result: CertificationResult): Promise<void> {
  const { report } = result;
  expect(report.ok).toBe(true);
  const byCheck = new Map(report.evidence.map((entry) => [entry.check, entry]));
  expect(RECIPE_CHECKS.map((id) => [id, byCheck.get(id)?.status])).toEqual(
    RECIPE_CHECKS.map((id) => [id, "pass"]),
  );
  for (const entry of report.evidence) {
    expect(["pass", "skipped"]).toContain(entry.status);
    if (entry.status === "skipped") expect(entry.reason).not.toBeNull();
    expect(entry.simulated).toBe(false);
  }
  const flow = byCheck.get("auth.flow.api");
  const steps = (flow?.details.steps ?? []) as { ok: boolean }[];
  expect(steps).toHaveLength(24);
  expect(steps.every((step) => step.ok)).toBe(true);
  const stored = evidenceFiles(c.root, report.evidence);
  for (const secret of result.generatedSecrets) {
    expect(JSON.stringify(result.plan)).not.toContain(secret);
    expect(stored).not.toContain(secret);
  }
  for (const entry of report.evidence) {
    const port = entry.details.port;
    if (typeof port === "number") expect(await portReleased(port)).toBe(true);
  }
}

function summarize(
  c: CertificationCase,
  result: CertificationResult,
  extra: Record<string, unknown>,
): void {
  const flow = result.report.evidence.find((entry) => entry.check === "auth.flow.api");
  const summary = {
    case: c.name,
    root: c.root,
    planId: result.plan.planId,
    actions: result.plan.actions.length,
    timings: result.timings,
    profiles: result.report.profiles,
    evidence: result.report.evidence.map((entry) => ({
      id: entry.id,
      check: entry.check,
      status: entry.status,
      durationMs: entry.durationMs,
      summary: entry.summary,
    })),
    flowSteps: flow?.details.steps,
    flowTimings: flow?.details.timings,
    ...extra,
  };
  summaries.push(summary);
  console.log(prettyJson(summary));
}

async function certifyAndCheck(c: CertificationCase): Promise<CertificationResult> {
  const result = await certify(c);
  await expectCertified(c, result);
  return result;
}

describe.skipIf(!e2e)("certification: data.drizzle-sqlite + auth.better-auth", () => {
  test(
    "(a) fresh single-app project from create-hono",
    async () => {
      // Arrange
      const base = scratch("single");
      const root = await createHono(base, "fresh-app");
      commitAll(root);
      const c: CertificationCase = {
        name: "fresh-single",
        root,
        topology: "single",
        origin: "created",
        app: appFixture({
          id: "api",
          path: ".",
          port: 3000,
          entry: "src/index.ts",
          origin: "generated",
        }),
      };
      const generatedIndex = readFileSync(join(root, "src/index.ts"), "utf8");
      // Act
      const result = await certifyAndCheck(c);
      const generate = await bunRun(root, "db:generate");
      const schemaBefore = sha256Of(readFileSync(join(root, "src/db/auth-schema.ts")));
      await bunRun(root, "auth:generate");
      const schemaAfter = sha256Of(readFileSync(join(root, "src/db/auth-schema.ts")));
      // Assert
      expect(generate).toContain("No schema changes");
      expect(schemaAfter).toBe(schemaBefore);
      const entry = readFileSync(join(root, "src/index.ts"), "utf8");
      expect(removeRegion(removeRegion(entry, "auth.imports", "e"), "auth.routes", "e")).toBe(
        generatedIndex,
      );
      summarize(c, result, {
        dbGenerate: "No schema changes",
        authGenerate: "auth-schema.ts unchanged",
      });
    },
    TIMEOUT,
  );

  test(
    "(b) Bun monorepo with apps/api from create-hono",
    async () => {
      // Arrange
      const root = join(scratch("mono"), "mono");
      writeWorkspaceRoot(root, "mono");
      mkdirSync(join(root, "apps"), { recursive: true });
      await createHono(join(root, "apps"), "api");
      commitAll(root);
      const c: CertificationCase = {
        name: "fresh-monorepo",
        root,
        topology: "monorepo",
        origin: "created",
        app: appFixture({
          id: "api",
          path: "apps/api",
          port: 3000,
          entry: "src/index.ts",
          origin: "generated",
        }),
      };
      // Act
      const result = await certifyAndCheck(c);
      const generate = await bunRun(join(root, "apps/api"), "db:generate");
      // Assert
      expect(generate).toContain("No schema changes");
      expect(readFileSync(join(root, "apps/api/.gitignore"), "utf8")).toContain(
        "\n.env.local\n/data/\n",
      );
      summarize(c, result, { dbGenerate: "No schema changes" });
    },
    TIMEOUT,
  );

  test(
    "(c) adopted custom layout: server/main.ts, port 4310, custom scripts, human AGENTS.md, dirty tree",
    async () => {
      // Arrange
      const fx = await adoptedApp({ dirty: true });
      roots.push(fx.root);
      const c: CertificationCase = {
        name: "adopted-custom",
        root: fx.root,
        topology: "single",
        origin: "adopted",
        app: fx.app,
      };
      // Act
      const result = await certifyAndCheck(c);
      const generate = await bunRun(fx.root, "db:generate");
      // Assert
      expect(generate).toContain("No schema changes");
      const dirty = result.plan.preconditions.find(
        (p) => p.type === "path" && p.path === "server/main.ts",
      );
      expect(dirty).toMatchObject({ dirty: true });
      expect(readFileSync(join(fx.root, "AGENTS.md"), "utf8")).toBe(ADOPTED_AGENTS);
      const main = readFileSync(join(fx.root, "server/main.ts"), "utf8");
      expect(removeRegion(removeRegion(main, "auth.imports", "m"), "auth.routes", "m")).toBe(
        adoptedMain(true),
      );
      expect(
        result.report.evidence.find((entry) => entry.check === "build.typecheck.api")?.status,
      ).toBe("pass");
      summarize(c, result, { dbGenerate: "No schema changes" });
    },
    TIMEOUT,
  );
});
