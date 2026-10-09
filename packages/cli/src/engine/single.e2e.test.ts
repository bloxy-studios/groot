/**
 * Single-app topology E2E against the REAL generator (create-hono): the app
 * lands at the project root, is stitched (name, port), installs, gets its
 * initial commit, records a v2 single-topology blueprint, passes doctor, and
 * actually serves HTTP on its stitched port. Network + generator required:
 *
 *   GROOT_E2E=1 bun test single.e2e
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlueprintV2 } from "../core/contracts/blueprint.ts";
import { isPortFree } from "../core/ports.ts";
import { startServer } from "../core/verify/server.ts";
import { isHealthy, runDoctor } from "./doctor.ts";
import { loadManifest } from "./manifest.ts";
import { buildPlan } from "./plan.ts";
import { generateSingle, singleRootPlan, stitchSingle, validateSingleSelection } from "./single.ts";
import { verify } from "./verify.ts";

const e2e = process.env.GROOT_E2E === "1";

describe.skipIf(!e2e)("single-app topology (real create-hono)", () => {
  test("plants a root-level Hono app that installs, commits, passes doctor, and serves", async () => {
    const base = await mkdtemp(join(tmpdir(), "groot-single-e2e-"));
    const targetDir = join(base, "svc");
    const draft = buildPlan({
      name: "svc",
      targetDir,
      cliVersion: "2.0.0-e2e",
      selections: { web: "none", mobile: "none", desktop: "none", api: "hono", backend: "none" },
      options: {
        install: true,
        git: true,
        dirConflict: "error",
        keepFailed: false,
        verbose: false,
      },
    });
    const plan = singleRootPlan(draft, validateSingleSelection(draft.scaffolds, targetDir));

    await generateSingle(plan, { verbose: false });
    await stitchSingle(plan);
    const notes = await verify(plan, { verbose: false });

    const pkg = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "svc", private: true });
    expect(await readFile(join(targetDir, "src/index.ts"), "utf8")).toContain(
      "port: Number(process.env.PORT ?? 3001)",
    );
    const blueprint = BlueprintV2.parse(
      JSON.parse(await readFile(join(targetDir, "groot.json"), "utf8")),
    );
    expect(blueprint.project.topology).toBe("single");
    expect(notes.some((note) => note.includes("bun install OK"))).toBe(true);

    const loaded = await loadManifest(targetDir);
    expect(isHealthy(await runDoctor(loaded))).toBe(true);

    // Runtime: the stitched entry pins its blueprint port (3001). Occupancy
    // is a runtime fact, separate from the blueprint, so check it first.
    expect(isPortFree(3001)).toBe(true);
    const server = await startServer({
      argv: [process.execPath, "src/index.ts"],
      cwd: targetDir,
      env: process.env,
      port: 3001,
      readyPath: "/",
      readyTimeoutMs: 30_000,
      secrets: [],
    });
    try {
      const response = await fetch(server.baseUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Hono");
    } finally {
      await server.stop();
    }
  }, 420_000);
});
