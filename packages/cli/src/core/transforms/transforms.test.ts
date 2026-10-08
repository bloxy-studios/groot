import { describe, expect, test } from "bun:test";
import type { JsonOp, StructuredEdit } from "../contracts/plan.ts";
import { applyEdit, findRegions, removeRegion, TransformConflict } from "./index.ts";

/**
 * Run `body`, then put Object.prototype back exactly as it was, so a
 * prototype-pollution regression fails its own test without leaking into the
 * rest of the run: members `body` added are deleted and every original member
 * is redefined. Membership is tested with Object.hasOwn: `key in original`
 * would also find an added member through the polluted prototype itself.
 */
function isolatingObjectPrototype<T>(body: () => T): T {
  const original = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    return body();
  } finally {
    for (const key of Reflect.ownKeys(Object.prototype)) {
      if (!Object.hasOwn(original, key)) Reflect.deleteProperty(Object.prototype, key);
    }
    Object.defineProperties(Object.prototype, original);
  }
}

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

  test("pointers into the prototype chain are conflicts and leave Object.prototype untouched", () => {
    const originalNames = Object.getOwnPropertyNames(Object.prototype).sort();
    const originalHasOwn = Object.prototype.hasOwnProperty;
    const attempts: JsonOp[] = [
      { op: "remove", pointer: "/__proto__/hasOwnProperty" },
      { op: "set", pointer: "/__proto__/isAdmin", value: true },
      { op: "merge", pointer: "/__proto__", value: { polluted: "yes" } },
      { op: "set", pointer: "/constructor/prototype/isAdmin", value: true },
      { op: "append-unique", pointer: "/scripts/prototype", value: "x" },
    ];
    const { outcomes, names, hasOwn } = isolatingObjectPrototype(() => ({
      outcomes: attempts.map((op) => {
        try {
          return applyEdit(`{"name":"app","scripts":{}}\n`, { kind: "json", ops: [op] }, "a.json");
        } catch (error) {
          return error;
        }
      }),
      names: Object.getOwnPropertyNames(Object.prototype).sort(),
      hasOwn: Object.prototype.hasOwnProperty,
    }));
    for (const outcome of outcomes) expect(outcome).toBeInstanceOf(TransformConflict);
    expect(names).toEqual(originalNames);
    expect(hasOwn).toBe(originalHasOwn);
  });

  test("the prototype isolation those checks run in removes members a regression adds", () => {
    // Arrange: a harmless stand-in for pollution (unique name, not enumerable).
    const probe = "grootPollutionProbe";

    // Act
    isolatingObjectPrototype(() => {
      Object.defineProperty(Object.prototype, probe, {
        value: true,
        configurable: true,
        writable: true,
      });
    });

    // Assert
    expect(Object.hasOwn(Object.prototype, probe)).toBe(false);
    expect(probe in {}).toBe(false);
  });

  test("inherited members are not JSON members: ops create own members instead", () => {
    const out = applyEdit(
      "{}\n",
      {
        kind: "json",
        ops: [
          { op: "set-if-absent", pointer: "/toString", value: "own" },
          { op: "merge", pointer: "/valueOf", value: { a: 1 } },
          { op: "append-unique", pointer: "/hasOwnProperty", value: "x" },
          { op: "set", pointer: "/isPrototypeOf/deep", value: 1 },
        ],
      },
      "a.json",
    );
    expect(JSON.parse(out)).toEqual({
      toString: "own",
      valueOf: { a: 1 },
      hasOwnProperty: ["x"],
      isPrototypeOf: { deep: 1 },
    });
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

  test("a begin marker with a missing or malformed hash is a conflict, never overwritten", () => {
    for (const begin of [
      "<!-- groot:begin project-context -->",
      "<!-- groot:begin project-context sha256:DEADBEEF -->",
    ]) {
      const text = `# Notes\n\n${begin}\nmy hand-written notes\n<!-- groot:end project-context -->\n`;
      expect(findRegions(text)[0]?.intact).toBe(false);
      expect(findRegions(text)[0]?.recordedHash).toBeNull();
      expect(() => applyEdit(text, edit("generated"), "AGENTS.md")).toThrow(/no valid sha256/);
      expect(() => removeRegion(text, "project-context", "AGENTS.md")).toThrow(TransformConflict);
    }
  });

  test("upsert then remove restores the original bytes (separator included)", () => {
    const cases: ["start" | "end", string][] = [
      ["start", "Prefer small commits.\n"],
      ["end", "# Acme\nAlways run the smoke test.\n"],
      ["start", ""],
      ["end", ""],
      ["start", "\n"],
      ["end", "\n"],
      ["start", "no final newline"],
      ["end", "no final newline"],
    ];
    for (const [placement, original] of cases) {
      const withRegion = applyEdit(original, { ...edit("@AGENTS.md"), placement }, "CLAUDE.md");
      expect(withRegion).not.toBe(original);
      expect(removeRegion(withRegion, "project-context", "CLAUDE.md")).toBe(original);
    }
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

  test("the semicolon-free create-hono shape gets the region right after the declaration", () => {
    const plain = `import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nexport default app\n`;
    const lines = applyEdit(plain, mount, "src/index.ts").split("\n");
    expect(lines[3]).toMatch(/^\/\/ groot:begin auth-mount sha256:/);
  });

  test("a statement that continues on the next line (a chain) is a conflict, never split", () => {
    const chained = `import { Hono } from "hono";\n\nconst app = new Hono()\n  .basePath("/api")\n  .get("/health", (c) => c.text("ok"));\n\nexport default app;\n`;
    expect(() => applyEdit(chained, mount, "src/index.ts")).toThrow(
      /line 3 continues on line 4 — refusing to insert mid-expression/,
    );
    const commented = `const app = new Hono()\n  // request logging\n  .use(logger());\nexport default app;\n`;
    expect(() => applyEdit(commented, mount, "src/index.ts")).toThrow(TransformConflict);
    const trailing = `const app =\n  new Hono();\n`;
    expect(() => applyEdit(trailing, { ...mount, anchor: "^const app =" }, "src/index.ts")).toThrow(
      /continues on line 2/,
    );
  });

  test("a quote inside a comment of a multi-line statement cannot hide its end", () => {
    const jsdoc = `const app = new Hono({\n  /** Don't strip trailing slashes */\n  strict: false,\n});\n\napp.get("/", (c) => c.text("hi"));\n\nexport default app;\n`;
    const lines = applyEdit(jsdoc, mount, "src/index.ts").split("\n");
    expect(lines[lines.indexOf("});") + 1]).toMatch(/^\/\/ groot:begin auth-mount sha256:/);
  });

  test("a statement whose end the scan cannot find is a conflict, not a guess", () => {
    const stray = `const app = new Hono({\n  getPath: (req) => req.url.replace(/'/g, ""),\n});\nexport default app;\n`;
    expect(() => applyEdit(stray, mount, "src/index.ts")).toThrow(
      /could not find where the statement on line 1 ends/,
    );
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

describe("line endings", () => {
  const crlf = (text: string): string => text.replace(/\n/g, "\r\n");
  const region = {
    kind: "managed-region" as const,
    regionId: "project-context",
    content: "## Layout\n- apps/api",
    commentStyle: "html" as const,
    placement: "end" as const,
  };
  const edits: [string, StructuredEdit][] = [
    ["# Acme\n\nAlways run the smoke test.\n", region],
    [
      "const app = new Hono();\n\nexport default app;\n",
      {
        kind: "source-anchor",
        anchor: String.raw`^const app = new Hono\b`,
        anchorDescription: "the app declaration",
        position: "after-line",
        regionId: "auth-mount",
        content: "app.use(auth);",
        commentStyle: "slash",
      },
    ],
    ["node_modules\n", { kind: "lines", lines: [".groot/"], header: "# groot" }],
    ["A=1\n", { kind: "env", entries: [{ name: "B", value: "2", comment: "b" }] }],
    [
      '{\n  "name": "app"\n}\n',
      { kind: "json", ops: [{ op: "set", pointer: "/private", value: true }] },
    ],
  ];

  test("a CRLF file stays CRLF on every line: the LF result with CRLF endings", () => {
    for (const [lf, edit] of edits) {
      const out = applyEdit(crlf(lf), edit, "file");
      expect(out).toBe(crlf(applyEdit(lf, edit, "file")));
      expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    }
  });

  test("re-applying to a CRLF file returns it unchanged, so the no-op is detectable", () => {
    for (const [lf, edit] of edits) {
      const once = applyEdit(crlf(lf), edit, "file");
      expect(applyEdit(once, edit, "file")).toBe(once);
    }
    const gitignore = "node_modules\r\n.env\r\n";
    expect(applyEdit(gitignore, { kind: "lines", lines: [".env"], header: null }, "x")).toBe(
      gitignore,
    );
  });

  test("removeRegion keeps CRLF; a no-op leaves even a mixed file untouched", () => {
    const original = crlf("# Acme\nNotes.\n");
    const withRegion = applyEdit(original, region, "AGENTS.md");
    expect(removeRegion(withRegion, "project-context", "AGENTS.md")).toBe(original);
    const mixed = "a\r\nb\nc\r\n";
    expect(applyEdit(mixed, { kind: "lines", lines: ["b"], header: null }, "x")).toBe(mixed);
  });
});
