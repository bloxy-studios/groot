# groot.dev design system — "Paper & Ink"

> Adopted for the docs site (owner decision, 2026-07-11): the visual language of the Cursor design system — warm paper, near-black ink, one hot orange — applied to groot's own brand. Tone: modern. Energy: medium. Audience: developers and software teams.

## Provenance & substitutions

The token set below was extracted from cursor.com and adopted **as a visual language only**. groot keeps its own identity:

- **No Cursor brand assets.** Cursor's logo, favicon, and Open Graph imagery are their trademarks and are not used. groot's mark is the 🌳 glyph + the `groot` wordmark set in the display face.
- **CursorGothic is proprietary.** The open-source substitute is **[Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk)** (same grotesque skeleton and quirky terminals), used for both headings and body — matching the source system's single-family approach. Code is **JetBrains Mono**.
- The source system's `body: 13px` is an app-UI size; long-form doc pages read at 15px with 13px reserved for UI labels, nav, and table meta (captured below as an explicit adaptation).

## Tokens

| Role | Token | Value |
| --- | --- | --- |
| Background | `--bg` | `#F7F7F4` |
| Primary / text | `--ink` | `#26251E` |
| Accent | `--accent` | `#F54E00` |
| Link | `--link` | `#F54E00` |
| Secondary surface | `--panel` | `#EFE6D7` |
| Soft text (derived) | `--ink-soft` | `rgba(38, 37, 30, 0.66)` |
| Hairline (derived) | `--line` | `rgba(38, 37, 30, 0.14)` |
| Terminal surface (derived) | `--term` | `#26251E` (ink as a surface; paper text on top) |

Rules of use:

- Paper (`--bg`) is the canvas everywhere; panels (`--panel`) mark grouped content (cards, table headers, blockquotes). Dark ink (`--term`) is reserved for terminal/code blocks — the one place the contrast flips.
- **Orange is scarce.** Links, primary CTAs, step numerals, active states. Never body text, never backgrounds larger than a button.
- Borders are 1px hairlines (`--line`); radius is small (6–10px); no shadows heavier than `0 1px 2px rgba(38,37,30,.06)`. Structure over decoration.

## Typography

| Role | Face | Size / weight |
| --- | --- | --- |
| Display (hero) | Space Grotesk | 44–56px, 700, tight leading (1.05), −0.02em tracking |
| h1 | Space Grotesk | 26px / 700 |
| h2 | Space Grotesk | 20px / 700 |
| h3 | Space Grotesk | 16px / 600 |
| Body | Space Grotesk | 15px / 400, 1.65 leading (adaptation of the 13px UI base) |
| UI labels, nav, table meta | Space Grotesk | 13px / 500 |
| Code | JetBrains Mono | 13px |

## Components

- **Nav**: sticky, paper background with blur, hairline bottom border; wordmark left, 13px links right, GitHub link last.
- **Terminal card**: `--term` surface, 10px radius, traffic-light dots omitted (not part of this language); paper-colored text, orange for the `$` prompt and groot's `◇` progress glyphs.
- **Slot cards**: `--panel` surface, 1px hairline, framework name in h3, path + port in mono 13px.
- **Step numerals**: 26px Space Grotesk 700 in `--accent`, content in ink.
- **Doc pages**: rendered markdown; tables get hairline borders with `--panel` header rows; blockquotes get a 3px `--accent` left rule on `--panel`; inline code on `--panel` chips; fenced code on `--term`.
- **Buttons**: primary = `--accent` fill, paper text, 8px radius; secondary = 1px ink border on paper. 13px, 600.

## Tailwind mapping

The site itself is dependency-free hand-authored CSS (tokens above as custom properties), but the system is Tailwind-shaped by design — for any future Tailwind consumer:

```js
// tailwind.config.js (excerpt)
export default {
  theme: {
    extend: {
      colors: {
        bg: "#F7F7F4",
        ink: "#26251E",
        accent: "#F54E00",
        panel: "#EFE6D7",
      },
      fontFamily: {
        sans: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
};
```

## Voice

Short declaratives. Verbs from the plant metaphor (plant, grow, tend) used precisely, never cutely. Numbers and commands carry the argument; adjectives don't.
