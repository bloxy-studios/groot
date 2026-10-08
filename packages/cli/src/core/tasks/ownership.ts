/**
 * File ownership for tasks: project-relative globs a task may change.
 *
 * Matching (review): `**` spans directories, `*` and `?` stay within one
 * segment, `{a,b}` alternates, `[...]` is a character class; a pattern with
 * no glob characters names a file or a whole directory ("src" = "src/**").
 *
 * Overlap (scheduling) is deliberately conservative — two tasks whose
 * patterns COULD touch the same file never run at the same time. Patterns
 * are compared by their literal directory prefix: identical prefixes, or one
 * prefix containing the other, overlap; `**` overlaps everything.
 */
import { GrootV2Error } from "../errors.ts";

const GLOB_CHARS = /[*?[{]/;

export function validateOwnership(glob: string): string {
  const pattern = glob.trim().replace(/^\.\//, "");
  if (
    pattern === "" ||
    pattern.startsWith("/") ||
    /^[A-Za-z]:/.test(pattern) ||
    pattern.includes("\\") ||
    pattern.split("/").includes("..")
  ) {
    throw new GrootV2Error("GROOT_E_USAGE", `Invalid ownership pattern "${glob}".`, {
      hint: 'Ownership globs are project-relative POSIX patterns, e.g. "src/**" or "apps/web/**".',
    });
  }
  return pattern;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translate one glob into an anchored RegExp (see the module comment). */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "/**");
  if (!GLOB_CHARS.test(pattern)) return new RegExp(`^${escapeRegExp(pattern)}(?:/.*)?$`);
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const options = pattern
        .slice(i + 1, end)
        .split(",")
        .map(escapeRegExp);
      out += `(?:${options.join("|")})`;
      i = end;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      const body = pattern
        .slice(i + 1, end)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      out += `[${body}]`;
      i = end;
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesOwnership(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Literal leading directory path of a pattern ("" when it starts with a glob). */
export function literalPrefix(glob: string): string {
  const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (GLOB_CHARS.test(segment)) break;
    segments.push(segment);
  }
  return segments.join("/");
}

function containsPrefix(outer: string, inner: string): boolean {
  return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

export function patternsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return containsPrefix(pa, pb) || containsPrefix(pb, pa);
}

/** The first overlapping pair between two ownership sets, or null. */
export function ownershipOverlap(
  a: readonly string[],
  b: readonly string[],
): readonly [string, string] | null {
  for (const left of a) {
    for (const right of b) {
      if (patternsOverlap(left, right)) return [left, right];
    }
  }
  return null;
}
