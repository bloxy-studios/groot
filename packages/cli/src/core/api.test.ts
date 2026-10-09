/**
 * The core API's task-prompt context: a runner's prompt carries project
 * facts — names, commands, and the ids of failing evidence — never a check's
 * output, even when stored evidence quotes a value the redactor can't know.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { evidenceFixture, registeredProject } from "../cli/test-support.ts";
import { createApi, taskContextProvider } from "./api.ts";
import { removeScratchDirs } from "./executor/test-support.ts";
import { createContext } from "./runtime.ts";
import { storeEvidence } from "./verify/store.ts";

afterAll(removeScratchDirs);

describe("task prompt context", () => {
  test("a failing check is a known gap by id and status; its output never reaches the prompt", async () => {
    // Arrange — evidence on disk whose summary quotes a value (e.g. stored by an older groot).
    const root = registeredProject(["api"]);
    const leaked = `leaked${crypto.randomUUID().replaceAll("-", "")}`;
    const { artifacts: _none, ...record } = evidenceFixture("build.script.api", "fail", {
      scope: { capability: null, unit: "apps/api", operationId: null, taskId: null },
      summary: `bun run build failed in apps/api (exit 1): upstream refused key ${leaked}`,
      nextStep: `retry with ${leaked}`,
    });
    const stored = storeEvidence(root, record, []);
    const ctx = createContext({ cwd: root });

    // Act
    const prompt = await taskContextProvider(ctx)(root, { objective: "fix the api build" });
    const context = await createApi().context(ctx, root, "fix the api build");

    // Assert
    expect(prompt).toContain(`Known gap: build.script.api is fail (evidence ${stored.id})`);
    expect(prompt).not.toContain(leaked);
    expect(JSON.stringify(context)).not.toContain(leaked);
  }, 60_000);
});
