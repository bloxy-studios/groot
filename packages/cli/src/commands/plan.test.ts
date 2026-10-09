import { describe, expect, test } from "bun:test";
import { GrootV2Error } from "../core/errors.ts";
import { capabilityRequests } from "./plan.ts";

/** Recipe id → the capability it supplies. */
const RECIPES: ReadonlyMap<string, string> = new Map([
  ["data.drizzle-sqlite", "data"],
  ["data.other", "data"],
  ["auth.better-auth", "auth"],
]);

function refusal(names: string[], recipes: string[]): unknown {
  try {
    capabilityRequests(names, recipes, null, RECIPES);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("plan add — capabilityRequests", () => {
  test("a --recipe for a dependency nobody named adds that capability first", () => {
    expect(capabilityRequests(["auth"], ["data.other"], null, RECIPES)).toEqual([
      { capability: "data", target: null, recipe: "data.other" },
      { capability: "auth", target: null, recipe: null },
    ]);
  });

  test("each --recipe attaches to the capability it supplies, wherever it is named", () => {
    expect(
      capabilityRequests(["auth", "data"], ["auth.better-auth", "data.other"], "api", RECIPES),
    ).toEqual([
      { capability: "auth", target: "api", recipe: "auth.better-auth" },
      { capability: "data", target: "api", recipe: "data.other" },
    ]);
  });

  test("an unknown recipe is refused as unknown in any position, listing the recipes there are", () => {
    // Arrange
    const orders = [
      ["auth.nope"],
      ["data.drizzle-sqlite", "bogus.recipe"],
      ["bogus.recipe", "data.drizzle-sqlite"],
      ["typo.recipe", "auth.better-auth"],
    ];

    // Act
    const errors = orders.map((recipes) => refusal(["auth"], recipes));

    // Assert
    for (const [index, error] of errors.entries()) {
      const unknown = (orders[index] as string[]).find((id) => !RECIPES.has(id)) as string;
      expect(error).toBeInstanceOf(GrootV2Error);
      expect(error).toMatchObject({
        id: "GROOT_E_UNKNOWN_CAPABILITY",
        message: `Unknown recipe "${unknown}".`,
        details: {
          refusals: [
            {
              code: "unknown-recipe",
              message: `Unknown recipe "${unknown}".`,
              alternatives: ["auth.better-auth", "data.drizzle-sqlite", "data.other"],
            },
          ],
        },
      });
    }
  });

  test("two recipes for one capability are a usage error", () => {
    const caught = refusal(["data"], ["data.drizzle-sqlite", "data.other"]);
    expect(caught).toBeInstanceOf(GrootV2Error);
    expect(caught).toMatchObject({ id: "GROOT_E_USAGE" });
  });

  test("repeating the same recipe is harmless", () => {
    expect(capabilityRequests(["data"], ["data.other", "data.other"], null, RECIPES)).toEqual([
      { capability: "data", target: null, recipe: "data.other" },
    ]);
  });
});
