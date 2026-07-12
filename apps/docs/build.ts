/**
 * Docs site builder — a pure repo tool (no dependencies; run with
 * `bun apps/docs/build.ts`). Renders docs/*.md through the local markdown
 * renderer into the "Paper & Ink" shell (apps/docs/DESIGN.md) and writes a
 * static site to apps/docs/dist for GitHub Pages.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown } from "./markdown.ts";

const ROOT = join(import.meta.dir, "../..");
const DIST = join(import.meta.dir, "dist");
const REPO_URL = "https://github.com/bloxy-studios/groot";

interface DocPage {
  readonly slug: string;
  readonly source: string;
  readonly title: string;
  readonly description: string;
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "cli-spec",
    source: "docs/cli-spec.md",
    title: "CLI spec",
    description:
      "The normative contract: every command, flag, exit code, and the groot.json schema.",
  },
  {
    slug: "architecture",
    source: "docs/architecture.md",
    title: "Architecture",
    description:
      "The resolve → preflight → generate → stitch → verify pipeline and the adapter contract.",
  },
  {
    slug: "scaffold-flows",
    source: "docs/scaffold-flows.md",
    title: "Scaffold flows",
    description:
      "Verified facts for every upstream generator — flags, output shapes, caveats, sources.",
  },
  {
    slug: "ci",
    source: "docs/ci.md",
    title: "CI & agents",
    description: "Recipes for scaffolding in CI and gating on machine-readable plans.",
  },
  {
    slug: "stability",
    source: "docs/stability.md",
    title: "Stability",
    description: "What semver covers from v1.0 — and what deliberately tracks upstream instead.",
  },
  {
    slug: "roadmap",
    source: "docs/roadmap.md",
    title: "Roadmap",
    description: "Where groot is headed, milestone by milestone.",
  },
  {
    slug: "expansion",
    source: "docs/expansion.md",
    title: "Expansion",
    description:
      "The research ledger: candidate scaffolds, new slots, add-ons, git/GitHub powers, and agent-era capabilities.",
  },
  {
    slug: "maintainers",
    source: "docs/maintainers.md",
    title: "Maintainers",
    description: "The runbook: releases, review policy, drift watch, security response.",
  },
];

/** Rewrite repo-relative markdown links to site/GitHub targets. */
export function resolveDocLink(href: string): string {
  if (/^(https?:)?\/\//.test(href) || href.startsWith("#") || href.startsWith("mailto:")) {
    return href;
  }
  const [path = "", fragment] = href.split("#");
  const anchor = fragment === undefined ? "" : `#${fragment}`;
  const clean = path.replace(/^\.\//, "");
  const docMatch = DOC_PAGES.find((page) => clean === page.source.replace("docs/", ""));
  if (docMatch !== undefined) return `${docMatch.slug}.html${anchor}`;
  if (clean === "") return anchor; // same-page fragment
  // Anything outside docs/ (../README.md, ../.github/…, ../scripts/…) → GitHub.
  const repoPath = clean.startsWith("../") ? clean.slice(3) : `docs/${clean}`;
  return `${REPO_URL}/blob/main/${repoPath}${anchor}`;
}

const CSS = `
:root {
  --bg: #f7f7f4;
  --ink: #26251e;
  --ink-soft: rgba(38, 37, 30, 0.66);
  --accent: #f54e00;
  --panel: #efe6d7;
  --line: rgba(38, 37, 30, 0.14);
  --term: #26251e;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: "Space Grotesk", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }

nav.site {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 24px;
  padding: 14px 24px;
  background: rgba(247, 247, 244, 0.88); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
  font-size: 13px; font-weight: 500;
}
nav.site .wordmark { font-size: 16px; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
nav.site .links { margin-left: auto; display: flex; gap: 18px; flex-wrap: wrap; }
nav.site a { color: var(--ink-soft); }
nav.site a:hover { color: var(--ink); text-decoration: none; }
nav.site a.active { color: var(--accent); }

.wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
.doc-wrap { max-width: 840px; margin: 0 auto; padding: 0 24px; }

/* ---------- landing ---------- */
header.hero { padding: 88px 0 56px; }
.hero h1 {
  font-size: clamp(36px, 6vw, 56px);
  font-weight: 700; line-height: 1.05; letter-spacing: -0.02em;
  max-width: 17ch;
}
.hero h1 em { font-style: normal; color: var(--accent); }
.hero p.lede { margin-top: 20px; max-width: 56ch; font-size: 17px; color: var(--ink-soft); }
.hero .cta { margin-top: 28px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.btn {
  display: inline-block; padding: 9px 18px; border-radius: 8px;
  font-size: 13px; font-weight: 600; border: 1px solid transparent;
}
.btn.primary { background: var(--accent); color: var(--bg); }
.btn.primary:hover { text-decoration: none; filter: brightness(0.94); }
.btn.ghost { border-color: var(--ink); color: var(--ink); }
.btn.ghost:hover { text-decoration: none; background: var(--panel); }

.term {
  background: var(--term); color: var(--bg);
  border-radius: 10px; padding: 22px 24px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 13px; line-height: 1.75;
  overflow-x: auto; box-shadow: 0 1px 2px rgba(38, 37, 30, 0.06);
}
.term .p { color: var(--accent); }
.term .d { color: rgba(247, 247, 244, 0.55); }
.hero .term { margin-top: 40px; }

section.band { padding: 48px 0; border-top: 1px solid var(--line); }
section.band h2 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
section.band > .wrap > p.sub, section.band .sub { color: var(--ink-soft); font-size: 14px; margin-bottom: 28px; }

.grid { display: grid; gap: 14px; }
.grid.cols-4 { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 18px;
}
.card .slot { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); }
.card h3 { font-size: 16px; font-weight: 600; margin: 6px 0 8px; }
.card .meta { font-size: 12.5px; color: var(--ink-soft); }
.card .meta code { background: transparent; padding: 0; }

.step { display: flex; gap: 16px; align-items: baseline; }
.step .n { font-size: 26px; font-weight: 700; color: var(--accent); min-width: 34px; }
.step h3 { font-size: 16px; font-weight: 600; }
.step p { font-size: 14px; color: var(--ink-soft); margin-top: 4px; }

.cmdrow {
  display: flex; gap: 18px; align-items: baseline; padding: 14px 0;
  border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
.cmdrow:last-child { border-bottom: none; }
.cmdrow code.cmd {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 3px 10px; font-size: 13px; white-space: nowrap;
}
.cmdrow p { font-size: 14px; color: var(--ink-soft); flex: 1; min-width: 240px; }

.trust { display: flex; gap: 10px; flex-wrap: wrap; }
.trust span {
  font-size: 12.5px; font-weight: 500; color: var(--ink-soft);
  border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; background: var(--bg);
}

footer.site {
  border-top: 1px solid var(--line); margin-top: 24px;
  padding: 32px 24px; font-size: 13px; color: var(--ink-soft);
  display: flex; gap: 18px; flex-wrap: wrap; align-items: baseline;
}
footer.site .tag { margin-left: auto; font-style: italic; }

/* ---------- doc pages ---------- */
.doc-head { padding: 44px 0 8px; }
.doc-head h1.page { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
.doc-head p.desc { color: var(--ink-soft); font-size: 14px; margin-top: 6px; }
.doc-nav { display: flex; gap: 8px; flex-wrap: wrap; padding: 18px 0 6px; }
.doc-nav a {
  font-size: 12.5px; font-weight: 500; color: var(--ink-soft);
  border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.doc-nav a:hover { color: var(--ink); text-decoration: none; background: var(--panel); }
.doc-nav a.active { color: var(--bg); background: var(--ink); border-color: var(--ink); }

article.doc { padding: 18px 0 72px; }
article.doc h1 { font-size: 26px; font-weight: 700; margin: 40px 0 14px; letter-spacing: -0.01em; }
article.doc h2 { font-size: 20px; font-weight: 700; margin: 36px 0 12px; padding-top: 18px; border-top: 1px solid var(--line); }
article.doc h3 { font-size: 16px; font-weight: 600; margin: 26px 0 10px; }
article.doc h4 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; }
article.doc h1:first-child { margin-top: 12px; }
article.doc .anchor { color: inherit; }
article.doc .anchor:hover { text-decoration: none; }
article.doc .anchor:hover::after { content: " #"; color: var(--accent); font-weight: 400; }
article.doc p { margin: 12px 0; }
article.doc ul, article.doc ol { margin: 12px 0 12px 26px; }
article.doc li { margin: 6px 0; }
article.doc code {
  background: var(--panel); border-radius: 4px; padding: 1.5px 6px; font-size: 12.5px;
}
article.doc pre {
  background: var(--term); color: var(--bg); border-radius: 10px;
  padding: 18px 20px; overflow-x: auto; margin: 16px 0;
  font-size: 12.5px; line-height: 1.7;
}
article.doc pre code { background: transparent; padding: 0; color: inherit; font-size: inherit; }
article.doc blockquote {
  border-left: 3px solid var(--accent); background: var(--panel);
  border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 16px 0;
  font-size: 14px;
}
article.doc blockquote p { margin: 6px 0; }
article.doc table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 13.5px; }
article.doc th {
  background: var(--panel); text-align: left; font-weight: 600;
  padding: 8px 12px; border: 1px solid var(--line); font-size: 12.5px;
}
article.doc td { padding: 8px 12px; border: 1px solid var(--line); vertical-align: top; }
article.doc hr { border: none; border-top: 1px solid var(--line); margin: 28px 0; }

@media (max-width: 640px) {
  header.hero { padding: 56px 0 40px; }
  nav.site { gap: 14px; }
}
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

function shell(options: {
  title: string;
  description: string;
  body: string;
  activeSlug: string | null;
}): string {
  const navLinks = [
    `<a href="cli-spec.html"${options.activeSlug === "docs" ? ' class="active"' : ""}>Docs</a>`,
    `<a href="ci.html">CI &amp; agents</a>`,
    `<a href="https://www.npmjs.com/package/create-groot">npm</a>`,
    `<a href="${REPO_URL}">GitHub</a>`,
  ].join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<meta name="description" content="${options.description}">
${FONTS}
<style>${CSS}</style>
</head>
<body>
<nav class="site"><a class="wordmark" href="./">🌳 groot</a><div class="links">${navLinks}</div></nav>
${options.body}
<footer class="site">
  <a href="${REPO_URL}">GitHub</a>
  <a href="https://www.npmjs.com/package/create-groot">npm</a>
  <a href="cli-spec.html">CLI spec</a>
  <a href="${REPO_URL}/blob/main/LICENSE">MIT © 2026 Bloxy Studios</a>
  <span class="tag">"I am groot." — every monorepo, eventually</span>
</footer>
</body>
</html>`;
}

const TRANSCRIPT = [
  `<span class="p">$</span> bun create groot my-app`,
  ``,
  `<span class="d">◆</span> Web app?      <span class="p">›</span> Next.js`,
  `<span class="d">◆</span> Mobile app?   <span class="p">›</span> Expo`,
  `<span class="d">◆</span> API?          <span class="p">›</span> Elysia`,
  `<span class="d">◆</span> Backend?      <span class="p">›</span> Convex`,
  ``,
  `<span class="p">◇</span> Planting turborepo trunk…`,
  `<span class="p">◇</span> Growing apps/web (Next.js)…`,
  `<span class="p">◇</span> Growing apps/mobile (Expo)…`,
  `<span class="p">◇</span> Writing apps/api (elysia)…`,
  `<span class="p">◇</span> Writing packages/backend (convex)…`,
  `<span class="p">◇</span> Stitching workspace…`,
  `<span class="p">◇</span> Installing workspace (bun install)…`,
  ``,
  `🌳 I am groot — your workspace is planted.`,
].join("\n");

function landing(): string {
  const body = `
<header class="hero"><div class="wrap">
  <h1>Plant a bun-first Turborepo. <em>Grow</em> the apps you actually want.</h1>
  <p class="lede">groot runs each framework's official generator — create-next-app, sv, create-expo-app, create-hono, Convex — and stitches the output into one coherent bun workspace. No vendored templates. Nothing to rot.</p>
  <div class="cta">
    <a class="btn primary" href="#install">Get started</a>
    <a class="btn ghost" href="cli-spec.html">Read the CLI spec</a>
  </div>
  <div class="term">${TRANSCRIPT}</div>
</div></header>

<section class="band" id="install"><div class="wrap">
  <h2>One command</h2>
  <p class="sub">Bun ≥ 1.2. Or grab the standalone binary — no Bun needed to run it.</p>
  <div class="term"><span class="p">$</span> bun create groot my-app

<span class="d"># or the standalone binary (checksum-verified installer)</span>
<span class="p">$</span> curl -fsSL ${REPO_URL.replace("github.com", "raw.githubusercontent.com")}/main/install.sh | bash</div>
</div></section>

<section class="band"><div class="wrap">
  <h2>The matrix</h2>
  <p class="sub">Pick per slot. Every combination arrives wired: workspace links, deconflicted ports, one lockfile.</p>
  <div class="grid cols-4">
    <div class="card"><div class="slot">🌐 Web</div><h3>Next.js · SvelteKit</h3><div class="meta mono">apps/web · :3000 / :5173</div></div>
    <div class="card"><div class="slot">📱 Mobile</div><h3>Expo</h3><div class="meta mono">apps/mobile · :8081</div></div>
    <div class="card"><div class="slot">⚡ API</div><h3>Elysia · Hono</h3><div class="meta mono">apps/api · :3001</div></div>
    <div class="card"><div class="slot">🗄️ Backend</div><h3>Convex</h3><div class="meta mono">packages/backend · cloud dev</div></div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>How it works</h2>
  <p class="sub">A strict pipeline — every stage succeeds completely or fails precisely. <a href="architecture.html">Architecture →</a></p>
  <div class="grid cols-3">
    <div class="step"><div class="n">1</div><div><h3>Generate</h3><p>Official generators, pinned majors, silence flags. Your day-1 output is today's framework — not a template frozen last spring.</p></div></div>
    <div class="step"><div class="n">2</div><div><h3>Stitch</h3><p>Package names, workspace links, dev ports, turbo outputs, env plumbing, one root lockfile — and a groot.json manifest as memory.</p></div></div>
    <div class="step"><div class="n">3</div><div><h3>Verify</h3><p>Structure checks, real install, git init. Later: <code>groot doctor</code> re-checks health any time, with suggested fixes.</p></div></div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>Then keep growing</h2>
  <div class="cmdrow"><code class="cmd">groot add hono</code><p>Grow another scaffold into an existing workspace — occupancy-checked, cross-wired by the same idempotent stitch, rolled back surgically on failure.</p></div>
  <div class="cmdrow"><code class="cmd">groot doctor --json</code><p>Health checks with suggested fixes: ports, lockfiles, manifests, per-framework invariants. Exit 0 or 5 — drops straight into CI.</p></div>
  <div class="cmdrow"><code class="cmd">groot init --preset ../flagship</code><p>Replicate any workspace's shape from its groot.json. Generator pins always come from the CLI you run — presets never freeze upstream.</p></div>
</div></section>

<section class="band"><div class="wrap">
  <h2>Built for CI and agents</h2>
  <p class="sub">Scriptability is a first-class feature, tested at the process level. <a href="ci.html">Recipes →</a></p>
  <div class="term"><span class="p">$</span> groot add elysia --dry-run --json | jq '.scaffolds[-1]'
<span class="d">{ "slot": "api", "framework": "elysia", "path": "apps/api", … }</span>

<span class="d"># never hangs on a prompt · pure-JSON stdout · spec'd exit codes</span></div>
</div></section>

<section class="band"><div class="wrap">
  <h2>Held to a higher bar</h2>
  <div class="trust">
    <span>MIT licensed</span>
    <span>Every PR: CI green + Greptile 5/5</span>
    <span>SBOM + Sigstore attestations on releases</span>
    <span>Weekly upstream-drift watch</span>
    <span>Checksum-verified installers</span>
    <span>Semver stability contract</span>
  </div>
</div></section>`;
  return shell({
    title: "groot — plant a bun-first Turborepo, grow the apps you want",
    description:
      "One command plants a complete bun workspace: Next.js or SvelteKit, Expo, Elysia or Hono, Convex — official generators, stitched together, nothing vendored.",
    body,
    activeSlug: null,
  });
}

function docPage(page: DocPage, html: string): string {
  const pills = DOC_PAGES.map(
    (p) =>
      `<a href="${p.slug}.html"${p.slug === page.slug ? ' class="active"' : ""}>${p.title}</a>`,
  ).join("");
  const body = `
<div class="doc-wrap">
  <div class="doc-head">
    <h1 class="page">${page.title}</h1>
    <p class="desc">${page.description} <a href="${REPO_URL}/blob/main/${page.source}">Edit on GitHub</a></p>
    <div class="doc-nav">${pills}</div>
  </div>
  <article class="doc">${html}</article>
</div>`;
  return shell({
    title: `${page.title} — groot docs`,
    description: page.description,
    body,
    activeSlug: "docs",
  });
}

export function buildSite(): string[] {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const written: string[] = [];
  writeFileSync(join(DIST, "index.html"), landing());
  written.push("index.html");

  for (const page of DOC_PAGES) {
    const markdown = readFileSync(join(ROOT, page.source), "utf8");
    const html = renderMarkdown(markdown, { resolveLink: resolveDocLink });
    writeFileSync(join(DIST, `${page.slug}.html`), docPage(page, html));
    written.push(`${page.slug}.html`);
  }

  // GitHub Pages: no Jekyll processing.
  writeFileSync(join(DIST, ".nojekyll"), "");
  written.push(".nojekyll");
  return written;
}

if (import.meta.main) {
  const files = buildSite();
  console.log(`built ${files.length} files → apps/docs/dist`);
  for (const file of files) console.log(`  ${file}`);
  // Sanity: every doc page must have rendered real content.
  for (const page of DOC_PAGES) {
    const html = readFileSync(join(DIST, `${page.slug}.html`), "utf8");
    if (html.length < 3000) throw new Error(`${page.slug}.html looks empty (${html.length} bytes)`);
  }
  console.log("sanity: all pages have content");
}
