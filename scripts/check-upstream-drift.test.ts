/**
 * Offline tests for the upstream drift checker. The registry is never touched:
 * `checkPins` takes an injected resolver, and the pin collection reads the same
 * workspace modules the CLI executes.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOWLIST,
  buildReport,
  checkPins,
  collectPinnedPackages,
  DOC_AGE_BUDGET_DAYS,
  daysSince,
  parsePin,
  parseVerifiedDate,
  rangeSeries,
  seriesOf,
} from "./check-upstream-drift.ts";

describe("pin parsing", () => {
  test("parsePin splits on the last @ (scoped names keep theirs)", () => {
    expect(parsePin("create-next-app@16")).toEqual({ name: "create-next-app", series: "16" });
    expect(parsePin("sv@0.16")).toEqual({ name: "sv", series: "0.16" });
    expect(parsePin("@scope/tool@2")).toEqual({ name: "@scope/tool", series: "2" });
    expect(() => parsePin("no-series")).toThrow();
  });

  test("seriesOf treats 0.x minors as their own series", () => {
    expect(seriesOf("16.2.10")).toBe("16");
    expect(seriesOf("0.19.4")).toBe("0.19");
    expect(seriesOf("2.10.4")).toBe("2");
  });

  test("rangeSeries reads caret/tilde ranges and skips unpinnable ones", () => {
    expect(rangeSeries("^1.4.0")).toBe("1");
    expect(rangeSeries("~0.16.2")).toBe("0.16");
    expect(rangeSeries("5")).toBe("5");
    expect(rangeSeries("*")).toBeNull();
    expect(rangeSeries("workspace:*")).toBeNull();
    expect(rangeSeries("latest")).toBeNull();
  });
});

describe("collectPinnedPackages", () => {
  test("reads every pin the CLI actually ships", () => {
    const { pins, notes } = collectPinnedPackages();
    expect(notes).toEqual([]); // Expo tag parses — a failure here means the adapter moved
    const byName = new Map(pins.map((pin) => [`${pin.name}@${pin.series}`, pin.source]));

    // Generator pins from trunk + matrix.
    expect(byName.has("create-turbo@2")).toBe(true);
    expect(byName.has("create-next-app@16")).toBe(true);
    expect(byName.has("sv@0.16")).toBe(true);
    expect(byName.has("create-expo-app@4")).toBe(true);
    expect(byName.has("create-hono@0.19")).toBe(true);
    // The Expo SDK line rides the template tag.
    expect(byName.has("expo@57")).toBe(true);
    // Direct-write template dependencies.
    expect(byName.has("elysia@1")).toBe(true);
    expect(byName.has("convex@1")).toBe(true);
    // Allowlisted entries are still collected (suppression happens at check time).
    expect([...byName.keys()].some((key) => key.startsWith("typescript@"))).toBe(true);
    expect([...byName.keys()].some((key) => key.startsWith("@types/node@"))).toBe(true);
  });
});

describe("checkPins", () => {
  const pins = [
    { name: "create-next-app", series: "16", source: "matrix" },
    { name: "sv", series: "0.16", source: "matrix" },
    { name: "typescript", series: "5", source: "template" },
  ];

  test("no findings when latest stays in the pinned series", async () => {
    const { findings, suppressed } = await checkPins(pins, async (name) => {
      return { "create-next-app": "16.9.1", sv: "0.16.7", typescript: "5.9.3" }[name] ?? "0.0.0";
    });
    expect(findings).toEqual([]);
    expect(suppressed).toEqual([]);
  });

  test("a new major and a 0.x minor bump are findings; allowlisted names are suppressed", async () => {
    const { findings, suppressed } = await checkPins(pins, async (name) => {
      return { "create-next-app": "17.0.2", sv: "0.17.0", typescript: "7.0.2" }[name] ?? "0.0.0";
    });
    expect(findings.map((f) => f.name).sort()).toEqual(["create-next-app", "sv"]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed.at(0)?.name).toBe("typescript");
    expect(suppressed.at(0)?.reason).toBe(ALLOWLIST.get("typescript"));
  });
});

describe("buildReport", () => {
  const finding = {
    name: "create-next-app",
    series: "16",
    latest: "17.0.2",
    source: "matrix",
  };

  test("findings produce a table, a call to action, and a fingerprint", () => {
    const report = buildReport([finding], [], []);
    expect(report.body).toContain("Upstream drift detected");
    expect(report.body).toContain("`create-next-app`");
    expect(report.body).toContain("docs/scaffold-flows.md");
    expect(report.body).toContain(`drift-fingerprint:${report.fingerprint}`);
  });

  test("the fingerprint is stable across latest-version patch churn and ordering", () => {
    const a = buildReport(
      [finding, { name: "sv", series: "0.16", latest: "0.17.0", source: "matrix" }],
      [],
      [],
    );
    const b = buildReport(
      [
        { name: "sv", series: "0.16", latest: "0.17.3", source: "matrix" },
        { ...finding, latest: "17.0.9" },
      ],
      [],
      [],
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = buildReport([finding], [], ["doc stale"]);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  test("suppressed entries land in the collapsed section, not the findings table", () => {
    const report = buildReport([], [{ ...finding, name: "typescript", reason: "intentional" }], []);
    expect(report.findings).toEqual([]);
    expect(report.body).toContain("Allowlisted pin lags");
    expect(report.body).toContain("intentional");
    expect(report.body).not.toContain("Upstream drift detected");
  });
});

describe("doc verification date", () => {
  test("parses the real header format", () => {
    expect(parseVerifiedDate("> **Last verified: 2026-07-10.** Every adapter change…")).toBe(
      "2026-07-10",
    );
    expect(parseVerifiedDate("no date here")).toBeNull();
  });

  test("daysSince counts whole days", () => {
    const now = new Date("2026-07-11T12:00:00Z");
    expect(daysSince("2026-07-10", now)).toBe(1);
    expect(daysSince("2026-04-01", now)).toBeGreaterThan(DOC_AGE_BUDGET_DAYS);
  });
});
