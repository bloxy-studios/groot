import { describe, expect, test } from "bun:test";
import { GrootV2Error } from "../core/errors.ts";
import { capabilityRequests } from "./plan.ts";

const SUPPLIES: Record<string, string> = {
  "data.drizzle-sqlite": "data",
  "data.other": "data",
  "auth.better-auth": "auth",
};
const capabilityOf = (id: string): string | undefined => SUPPLIES[id];

describe("plan add — capabilityRequests", () => {
  test("a --recipe for a dependency nobody named adds that capability first", () => {
    expect(capabilityRequests(["auth"], ["data.other"], null, capabilityOf)).toEqual([
      { capability: "data", target: null, recipe: "data.other" },
      { capability: "auth", target: null, recipe: null },
    ]);
  });

  test("each --recipe attaches to the capability it supplies, wherever it is named", () => {
    expect(
      capabilityRequests(["auth", "data"], ["auth.better-auth", "data.other"], "api", capabilityOf),
    ).toEqual([
      { capability: "auth", target: "api", recipe: "auth.better-auth" },
      { capability: "data", target: "api", recipe: "data.other" },
    ]);
  });

  test("an unknown recipe stays on the first capability, for the solver to refuse", () => {
    expect(capabilityRequests(["auth"], ["auth.nope"], null, capabilityOf)).toEqual([
      { capability: "auth", target: null, recipe: "auth.nope" },
    ]);
  });

  test("two recipes for one capability are a usage error", () => {
    let caught: unknown;
    try {
      capabilityRequests(["data"], ["data.drizzle-sqlite", "data.other"], null, capabilityOf);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GrootV2Error);
    expect(caught).toMatchObject({ id: "GROOT_E_USAGE" });
  });

  test("repeating the same recipe is harmless", () => {
    expect(capabilityRequests(["data"], ["data.other", "data.other"], null, capabilityOf)).toEqual([
      { capability: "data", target: null, recipe: "data.other" },
    ]);
  });
});
