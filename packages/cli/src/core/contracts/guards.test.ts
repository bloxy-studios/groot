/**
 * Contract guards for untrusted documents: a plan cannot carry the contents
 * of a dotenv file (whatever the letter case of its name), and a JSON edit
 * cannot address prototype machinery.
 */
import { describe, expect, test } from "bun:test";
import { isSecretBearingEdit, JsonOp, PlannedAction, type StructuredEdit } from "./plan.ts";

const SHA = `sha256:${"a".repeat(64)}`;

function fileEdit(path: string, edit: StructuredEdit, after: string | null): unknown {
  return {
    id: "s01",
    type: "file.edit",
    path,
    edit,
    expect: { state: "sha256", sha256: SHA },
    after: after === null ? null : { content: after, sha256: SHA },
    owns: [],
    createIfMissing: false,
    description: "edit",
    classes: ["fs.edit"],
    reversible: true,
    compensation: "restore from backup",
  };
}

const ENV_EDIT: StructuredEdit = {
  kind: "env",
  entries: [{ name: "BETTER_AUTH_URL", value: "http://localhost:3000", comment: null }],
};
const LINES_EDIT: StructuredEdit = { kind: "lines", lines: ["X=1"], header: null };

describe("file.edit never carries dotenv contents", () => {
  test("an env edit, or any edit of a non-example dotenv file, must have after = null", () => {
    for (const [path, edit] of [
      ["apps/web/.env.local", ENV_EDIT],
      [".env.example", ENV_EDIT],
      [".env", LINES_EDIT],
      ["apps/api/.env.production", LINES_EDIT],
    ] as const) {
      const parsed = PlannedAction.safeParse(fileEdit(path, edit, "SECRET=hunter2\n"));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["after"]);
      expect(PlannedAction.safeParse(fileEdit(path, edit, null)).success).toBe(true);
    }
  });

  test("example dotenv files and other files keep exact previews", () => {
    for (const path of [".env.example", "apps/web/.env.sample", ".env.template", ".envrc"]) {
      expect(PlannedAction.safeParse(fileEdit(path, LINES_EDIT, "X=1\n")).success).toBe(true);
    }
    expect(isSecretBearingEdit("README.md", LINES_EDIT)).toBe(false);
    expect(isSecretBearingEdit("README.md", ENV_EDIT)).toBe(true);
    expect(isSecretBearingEdit("apps/web/.env.development.local", LINES_EDIT)).toBe(true);
  });

  test("a dotenv name is matched in any letter case, as case-insensitive filesystems resolve it", () => {
    // Default macOS and Windows volumes open .env.local for `.ENV.local`.
    for (const path of [".ENV.local", "apps/web/.Env", ".env.PRODUCTION.LOCAL"]) {
      expect(isSecretBearingEdit(path, LINES_EDIT)).toBe(true);
      const parsed = PlannedAction.safeParse(fileEdit(path, LINES_EDIT, "SECRET=hunter2\n"));
      expect(parsed.error?.issues[0]?.path).toEqual(["after"]);
    }
    for (const path of [".ENV.EXAMPLE", "apps/web/.env.Sample", ".environment", "..env"]) {
      expect(isSecretBearingEdit(path, LINES_EDIT)).toBe(false);
    }
  });
});

describe("JSON pointers", () => {
  test("tokens reaching prototype machinery are rejected; ordinary pointers pass", () => {
    for (const pointer of [
      "/__proto__/isAdmin",
      "/constructor/prototype/x",
      "/scripts/prototype",
      "/__proto__",
      "no-leading-slash",
    ]) {
      expect(JsonOp.safeParse({ op: "remove", pointer }).success).toBe(false);
    }
    for (const pointer of [
      "",
      "/scripts/db:migrate",
      "/a~1b/~0c",
      "/__proto__x",
      "/workspaces/0",
    ]) {
      expect(JsonOp.safeParse({ op: "remove", pointer }).success).toBe(true);
    }
  });
});
