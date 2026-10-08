/**
 * Topology: a root package.json with `workspaces` (array, or `{ packages }`)
 * or a pnpm-workspace.yaml `packages:` list is a monorepo whose units are the
 * matching directories that contain a package.json; a root package.json
 * without workspaces is a single-app project whose unit is the root (".");
 * anything else is unknown. Workspace globs are expanded by walking real
 * directories (`*` within a segment, `**` across segments, `!` exclusions),
 * never through symlinks that leave the project.
 */
import type { Sha256 } from "../contracts/common.ts";
import type { ContradictionNote, FactFactory, ObservedFact } from "./facts.ts";
import type { ProjectFs } from "./fs.ts";
import type { RootManifest } from "./package-manager.ts";

export type TopologyValue = "single" | "monorepo" | "unknown";

export interface TopologyFindings {
  readonly topology: ObservedFact<TopologyValue>;
  readonly workspaces: ObservedFact<string[]>;
  /** Unit directories (project paths, "." for a single app), sorted. */
  readonly unitPaths: readonly string[];
  readonly notes: readonly string[];
  readonly contradictions: readonly ContradictionNote[];
}

const MAX_GLOB_DEPTH = 6;

function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted === null ? trimmed : (quoted[2] as string);
}

function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The `packages:` list of a pnpm-workspace.yaml (block or flow style) via a
 * tiny line parser — no YAML engine, no anchors, no evaluation. null when
 * the file has no `packages` key.
 */
export function parsePnpmWorkspace(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map(stripYamlComment);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return null;
  const inline = (lines[start] as string).replace(/^packages\s*:/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter((entry) => entry !== "");
  }
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item === null) {
      if (/^\S/.test(line)) break;
      continue;
    }
    const pattern = unquote(item[1] as string);
    if (pattern !== "") patterns.push(pattern);
  }
  return patterns;
}

function workspacesField(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && "packages" in value
      ? (value as { packages: unknown }).packages
      : null;
  if (!Array.isArray(list)) return null;
  return list.filter((entry): entry is string => typeof entry === "string");
}

function segmentRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function exclusionRegex(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? ".*"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${body}$`);
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Directories (with a package.json) matching workspace patterns; unmatched patterns reported. */
export async function expandWorkspaces(
  fs: ProjectFs,
  patterns: readonly string[],
): Promise<{ paths: string[]; unmatched: string[] }> {
  const include = patterns.filter((p) => !p.startsWith("!")).map(normalizePattern);
  const exclude = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => exclusionRegex(normalizePattern(p.slice(1))));
  const found = new Set<string>();
  const unmatched: string[] = [];

  const match = async (dir: string, segments: readonly string[], depth: number): Promise<void> => {
    const [segment, ...rest] = segments;
    if (segment === undefined) {
      if (dir !== "." && (await fs.isFile(`${dir}/package.json`))) found.add(dir);
      return;
    }
    if (depth > MAX_GLOB_DEPTH) return;
    const children = (await fs.list(dir)).filter((entry) => entry.type === "dir");
    if (segment === "**") {
      await match(dir, rest, depth);
      for (const child of children) {
        if (!child.symlink && !child.name.startsWith("."))
          await match(child.path, segments, depth + 1);
      }
      return;
    }
    const regex = segmentRegex(segment);
    for (const child of children) {
      if (regex.test(child.name)) await match(child.path, rest, depth + 1);
    }
  };

  for (const pattern of include) {
    const before = found.size;
    if (pattern !== "" && pattern !== ".") await match(".", pattern.split("/"), 0);
    if (found.size === before) unmatched.push(pattern);
  }
  const paths = [...found].filter((path) => !exclude.some((regex) => regex.test(path))).sort();
  return { paths, unmatched };
}

export async function detectTopology(
  fs: ProjectFs,
  rootManifest: RootManifest | null,
  fact: FactFactory,
): Promise<TopologyFindings> {
  const notes: string[] = [];
  const contradictions: ContradictionNote[] = [];
  const declared = rootManifest === null ? null : workspacesField(rootManifest.value.workspaces);
  const pnpmFile = await fs.readText("pnpm-workspace.yaml");
  const pnpmPatterns = pnpmFile === null ? null : parsePnpmWorkspace(pnpmFile.text);

  let patterns: string[] | null = null;
  let source = "";
  let fingerprint: Sha256 | null = null;
  if (declared !== null) {
    patterns = declared;
    source = "package.json#workspaces";
    fingerprint = rootManifest?.sha256 ?? null;
    if (pnpmPatterns !== null && pnpmPatterns.join("\n") !== declared.join("\n")) {
      contradictions.push({
        topic: "workspaces",
        explanation:
          "package.json workspaces and pnpm-workspace.yaml packages list different patterns",
        sources: ["package.json", "pnpm-workspace.yaml"],
      });
    }
  } else if (pnpmPatterns !== null) {
    patterns = pnpmPatterns;
    source = "pnpm-workspace.yaml#packages";
    fingerprint = pnpmFile?.sha256 ?? null;
  }

  if (patterns !== null) {
    const { paths, unmatched } = await expandWorkspaces(fs, patterns);
    for (const pattern of unmatched) {
      notes.push(`workspace pattern "${pattern}" matches no package directory`);
    }
    return {
      topology: fact({
        value: "monorepo",
        source,
        method: "manifest",
        confidence: "certain",
        fingerprint,
      }),
      workspaces: fact({
        value: patterns,
        source,
        method: "manifest",
        confidence: "certain",
        fingerprint,
      }),
      unitPaths: paths,
      notes,
      contradictions,
    };
  }
  if (rootManifest !== null) {
    const base = {
      source: "package.json",
      method: "manifest" as const,
      fingerprint: rootManifest.sha256,
    };
    return {
      topology: fact({ ...base, value: "single", confidence: "high" }),
      workspaces: fact({ ...base, value: [], confidence: "certain" }),
      unitPaths: ["."],
      notes,
      contradictions,
    };
  }
  const none = { source: "no package.json at the project root", method: "filesystem" as const };
  return {
    topology: fact({ ...none, value: "unknown", confidence: "low" }),
    workspaces: fact({ ...none, value: [], confidence: "low" }),
    unitPaths: [],
    notes,
    contradictions,
  };
}
