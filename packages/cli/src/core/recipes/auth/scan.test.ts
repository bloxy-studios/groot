import { describe, expect, test } from "bun:test";
import { codeLines, codeOnly, continuationAfter, statementEnd } from "./scan.ts";

describe("codeOnly", () => {
  test("blanks comments and literal contents but keeps line breaks and code", () => {
    // Arrange
    const text = `const a = "x("; // don't\n/* it's\n  [ */ const b = 'y{'\nconst c = \`t\${ f("}") }u\`\n`;
    // Act
    const code = codeOnly(text);
    // Assert
    expect(code.split("\n")).toHaveLength(text.split("\n").length);
    expect(code).not.toContain("don't");
    expect(code).not.toContain("x(");
    expect(code).not.toContain("y{");
    expect(code).toContain("const b =");
    expect(code).toContain("f(");
  });

  test("an apostrophe inside a JSDoc never opens a string", () => {
    // Arrange
    const text = "/**\n * Don't drop the logger: it's the audit trail.\n */\nconst x = (1)\n";
    // Act
    const lines = codeLines(text);
    // Assert
    expect(lines[3]).toBe("const x = (1)");
  });

  test("templates nested in a template's placeholder are read as code", () => {
    // Arrange
    const text = `const s = \`a\${\`b\${c}\`}d\`; const t = (1)\n`;
    // Act
    const code = codeOnly(text);
    // Assert
    expect(code).toContain("; const t = (1)");
  });

  test.each([
    ["closing brackets in a class", "x.replace(", "[)}\\]]+$", ', "")'],
    ["a quote", "const q = ", '"', "g; const t = (1)"],
    ["a backtick", "const q = ", "`", "; const t = (1)"],
    ["escaped slashes (not a comment)", "const u = ", "^https?:\\/\\/", "; f(1)"],
    ["a slash in a class", "const s = ", "[/]", "; f(1)"],
    ["an arrow before it", "(s) => ", "[(]", ".test(s)"],
    ["`return` before it", "return ", "[)]", ".test(s)"],
  ])("a regular expression literal with %s is blanked like a string", (_case, before, body, after) => {
    // Arrange
    const text = `${before}/${body}/${after}\n`;
    // Act
    const code = codeOnly(text);
    // Assert
    expect(code).toBe(`${before}/${" ".repeat(body.length)}/${after}\n`);
  });

  test.each([
    ["between names", "const r = a / b / c(1)"],
    ["after a call", "const r = f(x) / g(y) / 2"],
    ["after an index", "const r = a[0] / b[1]"],
    ["after a number", "const r = 10 / n / (2)"],
    ["in a TSX closing tag", "const el = <b>{a}</b>{(x)}<i>{y}</i>"],
    ["after a property named like a keyword", "const r = o.return / 2 / (x)"],
    ["that closes nothing on its line (after i++)", "const r = i++ / (2)"],
  ])("a slash %s stays code: it divides (or closes a tag)", (_case, text) => {
    expect(codeOnly(text)).toBe(text);
  });
});

describe("statementEnd", () => {
  test("balances brackets across lines, ignoring comments and strings", () => {
    // Arrange
    const code = codeLines(
      "const app = new Hono<{\n  /** the user's id (don't trust it) */\n  Variables: { id: string };\n}>();\nexport default app;\n",
    );
    // Act / Assert
    expect(statementEnd(code, 0)).toBe(3);
  });

  test("a line that only closes brackets ends where it stands", () => {
    // Arrange
    const code = codeLines('import {\n  Hono,\n} from "hono";\n');
    // Act / Assert
    expect(statementEnd(code, 2)).toBe(2);
  });

  test("never-balanced brackets → null", () => {
    expect(statementEnd(codeLines("const app = new Hono({\n"), 0)).toBeNull();
  });

  test("closing brackets inside a regular expression don't end the statement", () => {
    // Arrange
    const code = codeLines(
      'const app = new Hono({\n  getPath: (req) => {\n    const path = new URL(req.url).pathname.replace(/[)}\\]]+$/, "")\n    return path\n  },\n});\n',
    );
    // Act / Assert
    expect(statementEnd(code, 0)).toBe(5);
  });
});

describe("continuationAfter", () => {
  const after = (text: string, end = 0): number | null => continuationAfter(codeLines(text), end);

  test.each([
    [
      "a comment line inside a chain",
      "const app = new Hono()\n  // logging first\n  .use(logger())\n",
      2,
    ],
    [
      "a JSDoc with an apostrophe inside a chain",
      "const app = new Hono()\n  /**\n   * Don't log health checks.\n   */\n  .use(logger())\n",
      4,
    ],
    ["blank lines inside a chain", "const app = new Hono()\n\n\n  .get('/', h)\n", 3],
    ["an optional chain", "const app = new Hono()\n  ?.use(x)\n", 1],
    [
      "a block comment on the continuing line",
      "const app = new Hono()\n  /* first */ .use(x)\n",
      1,
    ],
    ["a trailing comma (more declarators)", "const app = new Hono(),\n  other = 1\n", 0],
    [
      "a call on the next line (no ASI before `(`)",
      "const app = new Hono()\n(globalThis as any).x = 1\n",
      1,
    ],
    [
      "CRLF line endings",
      "const app = new Hono()\r\n  // logging first\r\n  .use(logger())\r\n",
      2,
    ],
    [
      "a regular expression on the next line (no ASI before `/`: it divides)",
      "const app = new Hono()\n/[)]/.test(x)\n",
      1,
    ],
  ])("%s → the continuing line", (_name, text, line) => {
    expect(after(text)).toBe(line);
  });

  test.each([
    ["a semicolon ends it", "const app = new Hono();\n  // note\n  .use(x)\n"],
    ["the next statement", "const app = new Hono()\n\n// note\napp.use(x)\n"],
    [
      "a JSDoc then the next statement",
      "const app = new Hono()\n/** Don't remove: health */\napp.get('/h', h)\n",
    ],
    ["end of file", "const app = new Hono()\n"],
    ["a trailing line comment", "const app = new Hono() // the API\n\nexport default app\n"],
    ["a non-null assertion", "const app = new Hono()!\nexport default app\n"],
  ])("%s → null", (_name, text) => {
    expect(after(text)).toBeNull();
  });
});
