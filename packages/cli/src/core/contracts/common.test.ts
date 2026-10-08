/**
 * Project-relative path contracts: validated per segment, so no `..`
 * traversal survives — not even behind a newline or other control character.
 */
import { describe, expect, test } from "bun:test";
import { RelPath, UnitPath } from "./common.ts";

const accepted = [
  "apps/web",
  "src/index.ts",
  ".env.local",
  "apps/api/.env.local",
  "./src/x.ts",
  ".",
  "a..b/..c/d..",
  "file with spaces.txt",
  "ünïcode/路径.ts",
];

const rejected = [
  "a\n/../../x",
  "x\n/../../../etc/passwd",
  "a\r/../x",
  "tab\tname",
  "nul\0byte",
  "..",
  "../x",
  "a/../b",
  "a/..",
  "a//b",
  "a/",
  "/etc/passwd",
  "C:/x",
  "a\\b",
  "",
];

describe("RelPath", () => {
  test.each(accepted)("accepts %p", (path) => {
    expect(RelPath.safeParse(path).success).toBe(true);
  });

  test.each(rejected)("rejects %p", (path) => {
    expect(RelPath.safeParse(path).success).toBe(false);
  });
});

describe("UnitPath", () => {
  test("shares RelPath's rules besides the root '.'", () => {
    expect(UnitPath.safeParse(".").success).toBe(true);
    expect(UnitPath.safeParse("apps/web").success).toBe(true);
    expect(UnitPath.safeParse("a\n/../../x").success).toBe(false);
    expect(UnitPath.safeParse("apps/../..").success).toBe(false);
  });
});
