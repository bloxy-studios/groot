import { describe, expect, test } from "bun:test";
import { choiceIdsFor, findChoice, MATRIX, SLOT_ORDER, YES_DEFAULTS } from "./matrix.ts";
import type { Slot } from "./types.ts";

describe("scaffold matrix (normative — docs/architecture.md)", () => {
  test("slot order covers all four slots", () => {
    expect(SLOT_ORDER).toEqual(["web", "mobile", "api", "backend"]);
  });

  test("port allocation matches the architecture doc", () => {
    expect(findChoice("web", "next")?.port).toBe(3000);
    expect(findChoice("web", "sveltekit")?.port).toBe(5173);
    expect(findChoice("api", "elysia")?.port).toBe(3001);
    expect(findChoice("api", "hono")?.port).toBe(3001);
    expect(findChoice("mobile", "expo")?.port).toBe(8081);
    expect(findChoice("backend", "convex")?.port).toBeNull();
  });

  test("paths match the slot layout", () => {
    expect(findChoice("web", "next")?.path).toBe("apps/web");
    expect(findChoice("web", "sveltekit")?.path).toBe("apps/web");
    expect(findChoice("mobile", "expo")?.path).toBe("apps/mobile");
    expect(findChoice("api", "hono")?.path).toBe("apps/api");
    expect(findChoice("backend", "convex")?.path).toBe("packages/backend");
  });

  test("generators are pinned to majors; direct-write scaffolds are null", () => {
    expect(findChoice("web", "next")?.generator).toBe("create-next-app@16");
    expect(findChoice("web", "sveltekit")?.generator).toBe("sv@0.16");
    expect(findChoice("mobile", "expo")?.generator).toBe("create-expo-app@4");
    expect(findChoice("api", "hono")?.generator).toBe("create-hono@0.19");
    // Elysia and Convex are written directly by groot (docs/scaffold-flows.md).
    expect(findChoice("api", "elysia")?.generator).toBeNull();
    expect(findChoice("backend", "convex")?.generator).toBeNull();
  });

  test("--yes defaults are valid choices (flagship pairing: next + convex)", () => {
    for (const slot of SLOT_ORDER) {
      expect(choiceIdsFor(slot)).toContain(YES_DEFAULTS[slot]);
    }
    expect(YES_DEFAULTS.web).toBe("next");
    expect(YES_DEFAULTS.backend).toBe("convex");
  });

  test("every slot offers none, and ids are unique within a slot", () => {
    for (const slot of SLOT_ORDER) {
      const ids = choiceIdsFor(slot);
      expect(ids).toContain("none");
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("findChoice rejects ids from other slots", () => {
    const slots: Slot[] = ["mobile", "api", "backend"];
    for (const slot of slots) {
      expect(findChoice(slot, "next")).toBeUndefined();
    }
    expect(MATRIX.web.choices.map((c) => c.id)).toEqual(["next", "sveltekit"]);
  });
});
