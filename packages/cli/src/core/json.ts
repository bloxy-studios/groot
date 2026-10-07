/**
 * JSON helpers: canonical serialization for fingerprints, a tolerant JSONC
 * reader for config/lock formats that allow comments and trailing commas
 * (tsconfig.json, bun.lock), and format-preserving rewrites (indent +
 * trailing newline) so structured edits don't reformat a user's file.
 */

/** Stable stringify: object keys sorted recursively; arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** Strip // and /* *\/ comments and trailing commas outside strings, then parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(removeTrailingCommas(out));
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

export interface JsonFormat {
  readonly indent: string | number;
  readonly trailingNewline: boolean;
}

/** Detect a JSON file's indentation and trailing newline (defaults: 2 spaces, newline). */
export function detectJsonFormat(text: string): JsonFormat {
  const match = /^[{[]\s*\n([ \t]+)\S/.exec(text);
  const indent = match?.[1] ?? "  ";
  return {
    indent: indent.includes("\t") ? "\t" : indent.length,
    trailingNewline: text.endsWith("\n") || text.length === 0,
  };
}

export function stringifyWithFormat(value: unknown, format: JsonFormat): string {
  const body = JSON.stringify(value, null, format.indent);
  return format.trailingNewline ? `${body}\n` : body;
}

/** Pretty JSON with a trailing newline — Groot's own documents. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
