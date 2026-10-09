import { describe, expect, test } from "bun:test";
import { GrootV2Error } from "../../errors.ts";
import { journalState } from "./recipe.ts";

const journal = (...tags: string[]): string =>
  JSON.stringify({
    version: "7",
    dialect: "sqlite",
    entries: tags.map((tag, idx) => ({ idx, version: "6", when: 1, tag, breakpoints: true })),
  });

describe("journalState", () => {
  test.each([
    ["data's 0000 alone", journal("0000_data_init"), "ready"],
    ["0000 then auth's 0001", journal("0000_data_init", "0001_auth_init"), "applied"],
    [
      "0000 and 0001, then the developer's own db:generate",
      journal("0000_data_init", "0001_auth_init", "0002_owners", "0003_tags"),
      "applied",
    ],
  ])("%s → %s", (_case, text, state) => {
    expect(journalState(text, "drizzle/meta/_journal.json")).toBe(state as "ready" | "applied");
  });

  test.each([
    ["a migration of the developer's own after 0000", journal("0000_data_init", "0002_owners")],
    [
      "auth's 0001 after another migration",
      journal("0000_data_init", "0001_owners", "0001_auth_init"),
    ],
    ["no entries", journal()],
    ["unreadable JSON", "{"],
  ])("%s → conflict: a pre-generated 0001 would be wrong", (_case, text) => {
    expect(() => journalState(text, "drizzle/meta/_journal.json")).toThrow(GrootV2Error);
  });
});
