/**
 * Policy loading fails closed: an invalid or unreadable groot.json never
 * turns a restrictive policy into the permissive default. Only a project with
 * no v2 blueprint (no groot.json, or a v1 manifest) gets DEFAULT_POLICY.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPolicy } from "../api.ts";
import { DEFAULT_POLICY, type Policy } from "../contracts/blueprint.ts";
import { GrootV2Error } from "../errors.ts";
import { blueprintFixture } from "../test-fixtures.ts";
import { loadProjectPolicy } from "./project-policy.ts";
import { removeScratchDirs, scratchProject } from "./test-support.ts";

afterAll(removeScratchDirs);

const RESTRICTIVE: Policy = { allow: ["fs.create"], external: "deny" };

async function expectGrootError(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrootV2Error);
    return error as GrootV2Error;
  }
  throw new Error("expected a GrootV2Error");
}

function withGrootJson(text: string): string {
  const root = scratchProject();
  writeFileSync(join(root, "groot.json"), text);
  return root;
}

const loaders = [
  ["loadProjectPolicy", async (root: string) => (await loadProjectPolicy(root)).policy],
  ["core api projectPolicy", projectPolicy],
] as const;

for (const [name, load] of loaders) {
  describe(`${name}`, () => {
    test("a valid v2 blueprint's policy is used", async () => {
      const root = withGrootJson(JSON.stringify(blueprintFixture({ policy: RESTRICTIVE })));
      expect(await load(root)).toEqual(RESTRICTIVE);
    });

    test("no groot.json (an unregistered project) gets the default policy", async () => {
      expect(await load(scratchProject())).toEqual(DEFAULT_POLICY);
    });

    test("a v1 manifest (no policy) gets the default policy", async () => {
      const root = withGrootJson(
        JSON.stringify({
          $schema:
            "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json",
          version: 1,
          createdWith: "create-groot@1.10.0",
          conventions: { packagesNamespace: "@repo" },
          scaffolds: [],
        }),
      );
      expect(await load(root)).toEqual(DEFAULT_POLICY);
    });

    test("a restrictive policy next to an unrelated invalid field fails closed", async () => {
      const blueprint = blueprintFixture({ policy: RESTRICTIVE });
      const root = withGrootJson(
        JSON.stringify({ ...blueprint, project: { ...blueprint.project, packageManager: "pnpm" } }),
      );
      const error = await expectGrootError(load(root));
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    });

    test("an unparseable groot.json fails closed", async () => {
      const error = await expectGrootError(load(withGrootJson('{ "version": 2, "policy": ')));
      expect(error.id).toBe("GROOT_E_INVALID_DOCUMENT");
    });
  });
}
