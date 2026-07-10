import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { bannerText, SCAFFOLD_SLOTS, scaffoldMatrixSummary } from "./banner.ts";

describe("banner", () => {
  test("includes the package version", () => {
    expect(bannerText(pkg.version)).toContain(`v${pkg.version}`);
  });

  test("package version is valid semver", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});

describe("scaffold matrix", () => {
  test("covers all four slots", () => {
    const slots = SCAFFOLD_SLOTS.map((s) => s.slot);
    expect(slots).toEqual(["web", "mobile", "api", "backend"]);
  });

  test("summary mentions every option", () => {
    const summary = scaffoldMatrixSummary();
    for (const { options } of SCAFFOLD_SLOTS) {
      for (const option of options) {
        expect(summary).toContain(option);
      }
    }
  });
});
