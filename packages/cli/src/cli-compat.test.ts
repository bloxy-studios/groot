import { describe, expect, test } from "bun:test";
import { normalizeArgv } from "./cli-compat.ts";

describe("normalizeArgv (bun create groot compatibility)", () => {
  test("routes a bare destination to init", () => {
    expect(normalizeArgv(["my-app"])).toEqual(["init", "my-app"]);
    expect(normalizeArgv(["my-app", "--yes", "--web", "next"])).toEqual([
      "init",
      "my-app",
      "--yes",
      "--web",
      "next",
    ]);
  });

  test("leaves known subcommands untouched", () => {
    expect(normalizeArgv(["init", "my-app"])).toEqual(["init", "my-app"]);
    expect(normalizeArgv(["add", "expo"])).toEqual(["add", "expo"]);
    expect(normalizeArgv(["doctor"])).toEqual(["doctor"]);
  });

  test("leaves flag-led and empty invocations untouched", () => {
    expect(normalizeArgv([])).toEqual([]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--version"])).toEqual(["--version"]);
  });
});
