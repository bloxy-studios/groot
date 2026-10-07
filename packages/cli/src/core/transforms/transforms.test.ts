import { describe, expect, test } from "bun:test";
import { applyEdit, findRegions, removeRegion, TransformConflict } from "./index.ts";

describe("json edits", () => {
  const pkg = `{\n    "name": "api",\n    "scripts": {\n        "dev": "bun --watch src/index.ts"\n    }\n}\n`;

  test("merge preserves key order, indentation, and the trailing newline", () => {
    const out = applyEdit(
      pkg,
      {
        kind: "json",
        ops: [
          { op: "merge", pointer: "/dependencies", value: { hono: "4.9.0" } },
          { op: "set-if-absent", pointer: "/scripts/dev", value: "replaced?" },
          { op: "set", pointer: "/scripts/db:migrate", value: "bun run src/db/migrate.ts" },
        ],
      },
      "package.json",
    );
    expect(out).toBe(
      `{\n    "name": "api",\n    "scripts": {\n        "dev": "bun --watch src/index.ts",\n        "db:migrate": "bun run src/db/migrate.ts"\n    },\n    "dependencies": {\n        "hono": "4.9.0"\n    }\n}\n`,
    );
  });

  test("append-unique is idempotent and remove of a missing member is a no-op", () => {
    const edit = {
      kind: "json" as const,
      ops: [
        { op: "append-unique" as const, pointer: "/workspaces", value: "apps/*" },
        { op: "remove" as const, pointer: "/nope/deeper" },
      ],
    };
    const once = applyEdit(`{"workspaces":["packages/*"]}`, edit, "package.json");
    const twice = applyEdit(once, edit, "package.json");
    expect(JSON.parse(twice)).toEqual({ workspaces: ["packages/*", "apps/*"] });
    expect(twice).toBe(once);
  });

  test("unparseable JSON is a conflict, not a rewrite", () => {
    expect(() => applyEdit("{ broken", { kind: "json", ops: [] }, "package.json")).toThrow(
      TransformConflict,
    );
  });

  test("merging into a non-object is a conflict", () => {
    expect(() =>
      applyEdit(
        `{"dependencies": "nope"}`,
        { kind: "json", ops: [{ op: "merge", pointer: "/dependencies", value: { a: "1" } }] },
        "package.json",
      ),
    ).toThrow(/not an object/);
  });
});

describe("managed regions", () => {
  const edit = (content: string) => ({
    kind: "managed-region" as const,
    regionId: "project-context",
    content,
    commentStyle: "html" as const,
    placement: "end" as const,
  });

  test("creates a region after human content and preserves that content", () => {
    const human = "# My project\n\nHand-written notes.\n";
    const out = applyEdit(human, edit("## Layout\n- apps/api"), "AGENTS.md");
    expect(out.startsWith(human)).toBe(true);
    const [region] = findRegions(out);
    expect(region?.id).toBe("project-context");
    expect(region?.intact).toBe(true);
    expect(region?.body).toBe("## Layout\n- apps/api");
  });

  test("re-applying refreshes only the region; human text around it is untouched", () => {
    const first = applyEdit("Intro\n", edit("v1"), "AGENTS.md");
    const withMore = `${first}\nHuman footer\n`;
    const second = applyEdit(withMore, edit("v2"), "AGENTS.md");
    expect(second).toContain("Intro");
    expect(second).toContain("Human footer");
    expect(findRegions(second)[0]?.body).toBe("v2");
    expect(applyEdit(second, edit("v2"), "AGENTS.md")).toBe(second);
  });

  test("a human edit inside the region is a conflict, never overwritten", () => {
    const first = applyEdit("", edit("generated"), "AGENTS.md");
    const tampered = first.replace("generated", "generated + my notes");
    expect(findRegions(tampered)[0]?.intact).toBe(false);
    expect(() => applyEdit(tampered, edit("new"), "AGENTS.md")).toThrow(/edited by hand/);
  });

  test("removeRegion restores the surrounding text", () => {
    const base = "Keep me\n";
    const withRegion = applyEdit(base, edit("x"), "AGENTS.md");
    expect(removeRegion(withRegion, "project-context", "AGENTS.md").trimEnd()).toBe("Keep me");
  });
});

describe("source anchors", () => {
  const server = `import { Hono } from "hono";\n\nconst app = new Hono();\n\napp.get("/", (c) => c.text("hi"));\n\nexport default app;\n`;
  const mount = {
    kind: "source-anchor" as const,
    anchor: String.raw`^\s*(?:export\s+)?const\s+app\s*=\s*new\s+Hono\b`,
    anchorDescription: "the `const app = new Hono()` declaration",
    position: "after-line" as const,
    regionId: "auth-mount",
    content: `app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));`,
    commentStyle: "slash" as const,
  };

  test("inserts a managed region right after the unique anchor line", () => {
    const out = applyEdit(server, mount, "src/index.ts");
    const lines = out.split("\n");
    const anchor = lines.findIndex((line) => line.startsWith("const app = new Hono()"));
    expect(lines[anchor + 1]).toMatch(/^\/\/ groot:begin auth-mount sha256:/);
    expect(lines[anchor + 2]).toContain("auth.handler");
    expect(applyEdit(out, mount, "src/index.ts")).toBe(out);
  });

  test("a multi-line anchor statement is skipped as a whole", () => {
    const multi = `const app = new Hono({\n  strict: false,\n});\napp.get("/", () => {});\n`;
    const out = applyEdit(multi, mount, "src/index.ts");
    expect(out.indexOf("groot:begin")).toBeGreaterThan(out.indexOf("});"));
  });

  test("zero or several anchors are conflicts with a precise reason", () => {
    expect(() => applyEdit("export default {};\n", mount, "src/index.ts")).toThrow(
      /could not find/,
    );
    const twice = `${server}const app = new Hono();\n`;
    expect(() => applyEdit(twice, mount, "src/index.ts")).toThrow(/refusing to guess/);
    expect(() => applyEdit(null, mount, "src/index.ts")).toThrow(/does not exist/);
  });
});

describe("line and env edits", () => {
  test("lines: appends only the missing ones (exact-line membership)", () => {
    const out = applyEdit(
      "node_modules\n.env\n",
      { kind: "lines", lines: [".env", ".groot/", "*.db"], header: "# groot" },
      ".gitignore",
    );
    expect(out).toBe("node_modules\n.env\n\n# groot\n.groot/\n*.db\n");
    expect(applyEdit(out, { kind: "lines", lines: [".groot/"], header: null }, ".gitignore")).toBe(
      out,
    );
  });

  test("env: adds unassigned names only and keeps existing values", () => {
    const out = applyEdit(
      "DATABASE_URL=./data/custom.db\n",
      {
        kind: "env",
        entries: [
          { name: "DATABASE_URL", value: "./data/app.db", comment: null },
          { name: "BETTER_AUTH_URL", value: "http://localhost:3001", comment: "auth base URL" },
        ],
      },
      ".env.example",
    );
    expect(out).toBe(
      "DATABASE_URL=./data/custom.db\n\n# auth base URL\nBETTER_AUTH_URL=http://localhost:3001\n",
    );
  });
});
