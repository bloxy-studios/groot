/**
 * Tests for the docs-site markdown renderer, pinned to the constructs
 * docs/*.md actually use — including the tricky ones: GitHub-compatible
 * anchor slugs, escaped pipes in tables, source-numbered ordered lists,
 * and code spans protecting their contents from other inline rules.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSite, DOC_PAGES, resolveDocLink } from "./build.ts";
import { renderInline, renderMarkdown, slugify, splitTableRow } from "./markdown.ts";

describe("slugify (GitHub-compatible)", () => {
  test("matches the anchors the codebase links to", () => {
    // Referenced from engine/commands source comments and docs cross-links.
    expect(slugify("`groot add <scaffold>` (v0.3)")).toBe("groot-add-scaffold-v03");
    expect(slugify("Non-interactive contract (CI & agents)")).toBe(
      "non-interactive-contract-ci--agents",
    );
    expect(slugify("`groot.json` manifest")).toBe("grootjson-manifest");
    expect(slugify("Upstream drift watch")).toBe("upstream-drift-watch");
  });
});

describe("renderInline", () => {
  test("code spans are protected from other inline rules", () => {
    expect(renderInline("run `bun install --frozen-lockfile` now")).toBe(
      "run <code>bun install --frozen-lockfile</code> now",
    );
    // Asterisks inside code spans never become emphasis.
    expect(renderInline("use `--dir-conflict *` and **bold**")).toContain("<strong>bold</strong>");
    expect(renderInline("`a * b * c`")).toBe("<code>a * b * c</code>");
  });

  test("standalone numbers in prose survive (placeholder regression)", () => {
    expect(renderInline("ports 3000 and 3001 and `code`")).toBe(
      "ports 3000 and 3001 and <code>code</code>",
    );
  });

  test("links, autolinks, bold, italic, and HTML escaping", () => {
    expect(renderInline("[spec](./cli-spec.md#x)", { resolveLink: (h) => h })).toBe(
      '<a href="./cli-spec.md#x">spec</a>',
    );
    expect(renderInline("<https://bun.sh> wins")).toBe(
      '<a href="https://bun.sh">https://bun.sh</a> wins',
    );
    expect(renderInline("**bold** and *quiet*")).toBe("<strong>bold</strong> and <em>quiet</em>");
    expect(renderInline("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("splitTableRow", () => {
  test("honors escaped pipes inside cells", () => {
    expect(splitTableRow("| `error` \\| `merge` | on |")).toEqual(["`error` | `merge`", "on"]);
    expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });
});

describe("renderMarkdown", () => {
  test("headings carry GitHub-compatible ids", () => {
    const html = renderMarkdown("## `groot add <scaffold>` (v0.3)");
    expect(html).toContain('<h2 id="groot-add-scaffold-v03">');
  });

  test("tables render with header and body", () => {
    const html = renderMarkdown("| Flag | Default |\n| --- | --- |\n| `--yes` | off |");
    expect(html).toContain("<th>Flag</th>");
    expect(html).toContain("<td><code>--yes</code></td>");
  });

  test("fenced code is escaped verbatim", () => {
    const html = renderMarkdown("```sh\nbun create groot my-app <dir>\n```");
    expect(html).toContain('<pre class="lang-sh">');
    expect(html).toContain("my-app &lt;dir&gt;");
  });

  test("ordered lists keep source numbering across interruptions", () => {
    const html = renderMarkdown("3. third\n4. fourth");
    expect(html).toContain('<ol start="3">');
  });

  test("blockquotes with multiple paragraphs", () => {
    const html = renderMarkdown("> **Status:** normative.\n>\n> Second line.");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>Status:</strong>");
    expect(html).toContain("Second line.");
  });
});

describe("resolveDocLink", () => {
  test("doc-relative links become page links; repo files go to GitHub", () => {
    expect(resolveDocLink("./cli-spec.md#exit-codes")).toBe("cli-spec.html#exit-codes");
    expect(resolveDocLink("cli-spec.md")).toBe("cli-spec.html");
    expect(resolveDocLink("../SECURITY.md")).toBe(
      "https://github.com/bloxy-studios/groot/blob/main/SECURITY.md",
    );
    expect(resolveDocLink("../.github/workflows/e2e.yml")).toContain("/blob/main/.github/");
    expect(resolveDocLink("https://bun.sh")).toBe("https://bun.sh");
    expect(resolveDocLink("#local")).toBe("#local");
  });
});

describe("buildSite (end to end over the real docs)", () => {
  test("builds every page with real content and working cross-links", () => {
    const files = buildSite();
    expect(files).toContain("index.html");
    for (const page of DOC_PAGES) {
      expect(files).toContain(`${page.slug}.html`);
      const html = readFileSync(join(import.meta.dir, "dist", `${page.slug}.html`), "utf8");
      expect(html.length).toBeGreaterThan(3000);
      expect(html).toContain("Space Grotesk");
    }
    // The cli-spec page keeps the anchor the CLI's error hints point at.
    const spec = readFileSync(join(import.meta.dir, "dist", "cli-spec.html"), "utf8");
    expect(spec).toContain('id="groot-add-scaffold-v03"');
    expect(spec).toContain('id="grootjson-manifest"');
    // Cross-doc links were rewritten to .html.
    expect(spec).toContain('href="stability.html"');
    expect(spec).not.toContain('href="./stability.md"');
  });
});
