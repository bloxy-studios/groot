/**
 * Minimal markdown renderer for the docs site — dependency-free by design
 * (adding an npm dependency would change bun.lock; the docs build must stay
 * a pure repo tool). It covers exactly the constructs docs/*.md use:
 * headings (with GitHub-compatible anchor slugs), paragraphs, fenced code,
 * tables (incl. escaped pipes), ordered/unordered lists (source-numbered),
 * blockquotes, horizontal rules, bold/italic/inline code, links, and
 * <autolinks>. Anything the docs don't use is deliberately unsupported.
 */

export interface RenderOptions {
  /** Rewrite a markdown link target (e.g. ./cli-spec.md#x → cli-spec.html#x). */
  readonly resolveLink?: (href: string) => string;
}

/** Escape HTML-significant characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GitHub-compatible heading slug: lowercase, strip punctuation, spaces → hyphens (uncollapsed). */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/ /g, "-");
}

/** Inline markup: code spans (protected), links, autolinks, bold, italic. */
export function renderInline(text: string, options: RenderOptions = {}): string {
  const resolve = options.resolveLink ?? ((href: string): string => href);
  const codeSpans: string[] = [];
  let html = escapeHtml(text);

  // Protect code spans first so their contents are never styled or linked.
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\uE000${codeSpans.length - 1}\uE000`;
  });

  // [text](href) — href was escaped above, so unescape &amp; inside it.
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const target = resolve(href.replace(/&amp;/g, "&"));
    return `<a href="${escapeHtml(target)}">${label}</a>`;
  });

  // <https://…> autolinks (already escaped to &lt;…&gt;).
  html = html.replace(
    /&lt;(https?:\/\/[^&\s]+)&gt;/g,
    (_match, url: string) => `<a href="${url}">${url}</a>`,
  );

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");

  return html.replace(
    /\uE000(\d+)\uE000/g,
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );
}

/** Split a table row into cells, honoring escaped pipes (\|). */
export function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\" && row[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  // Leading/trailing pipes produce empty first/last cells — drop them.
  if (cells.at(0) === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

const isTableDivider = (line: string): boolean =>
  /^\|?[\s:|-]+\|?$/.test(line) && line.includes("-");

/** Render a full markdown document to HTML. */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let i = 0;

  const inline = (text: string): string => renderInline(text, options);

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code.
    const fence = line.match(/^```(\w*)/);
    if (fence !== null) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      const langClass = language === "" ? "" : ` class="lang-${language}"`;
      blocks.push(`<pre${langClass}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      const slug = slugify(text);
      blocks.push(
        `<h${level} id="${slug}"><a class="anchor" href="#${slug}">${inline(text)}</a></h${level}>`,
      );
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}\s*$/.test(line)) {
      blocks.push("<hr>");
      i += 1;
      continue;
    }

    // Blockquote (contiguous > lines, indentation tolerated).
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const paragraphs = quoted
        .join("\n")
        .split(/\n{2,}|\n(?=\s*$)/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => `<p>${inline(p.replace(/\n/g, " "))}</p>`)
        .join("");
      blocks.push(`<blockquote>${paragraphs}</blockquote>`);
      continue;
    }

    // Table.
    if (line.trimStart().startsWith("|") && isTableDivider(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|")) {
        rows.push(splitTableRow((lines[i] ?? "").trim()));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((cells) => `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Lists (single level; ordered lists keep their source numbering).
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch !== null) {
      const ordered = /\d+\./.test(listMatch[2] ?? "");
      const start = ordered ? Number.parseInt(listMatch[2] ?? "1", 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = (lines[i] ?? "").match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (itemMatch === null || /\d+\./.test(itemMatch[2] ?? "") !== ordered) break;
        let item = itemMatch[3] ?? "";
        i += 1;
        // Indented continuation lines belong to the current item.
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? "") &&
          (lines[i] ?? "").match(/^(\s*)([-*]|\d+\.)\s+/) === null &&
          !/^\s*>/.test(lines[i] ?? "")
        ) {
          item += ` ${(lines[i] ?? "").trim()}`;
          i += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      blocks.push(`<${tag}${startAttr}>${items.join("")}</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or a structural line.
    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim() === "" ||
        /^(#{1,4})\s/.test(next) ||
        next.startsWith("```") ||
        /^\s*>/.test(next) ||
        next.trimStart().startsWith("|") ||
        /^(\s*)([-*]|\d+\.)\s+/.test(next) ||
        /^-{3,}\s*$/.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      i += 1;
    }
    blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return blocks.join("\n");
}
