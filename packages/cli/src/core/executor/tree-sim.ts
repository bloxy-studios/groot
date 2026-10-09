/**
 * Simulated directory-tree hashes for rollback previews.
 *
 * A generator step records `tree:<dir>` = hashTree(dir) (core/fs/hash.ts),
 * and later steps commonly patch files inside that tree. Rollback undoes
 * steps in reverse, so by the time it reaches the generator those patches
 * are gone — but a preview must decide BEFORE changing anything. This module
 * computes the hash the tree WILL have once the later file changes are
 * undone: the current listing with per-file overrides, hashed exactly like
 * hashTree (same ignore list, same "rel\0sha" lines, same DFS order with
 * per-level localeCompare — reproduced by a segment-wise sort). A parity
 * test pins it to hashTree so the two can't drift apart silently.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sha256 } from "../contracts/common.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { parseKey, pathKind } from "./fsops.ts";

/** hashTree's default ignore list (core/fs/hash.ts). */
const IGNORED = ["node_modules", ".git", ".groot", ".turbo"];

async function listEntries(
  absDir: string,
  prefix: string,
  out: Map<string, string>,
): Promise<void> {
  for (const entry of await readdir(absDir, { withFileTypes: true })) {
    if (IGNORED.includes(entry.name)) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) await listEntries(abs, rel, out);
    else if (entry.isFile()) out.set(rel, sha256Of(await readFile(abs)));
    else if (entry.isSymbolicLink()) out.set(rel, "symlink");
  }
}

/** Segment-wise localeCompare = the walk's per-directory sort, flattened. */
function compareRel(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = (left[i] as string).localeCompare(right[i] as string);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function isIgnoredRel(rel: string): boolean {
  return rel.split("/").some((segment) => IGNORED.includes(segment));
}

/**
 * Hash of the tree at `treePath` after applying `overrides` (simulated
 * current hashes keyed like the journal: file paths and `tree:` keys, both
 * project-relative). A file override of null removes the file, a hash adds or
 * replaces it; a nested `tree:` override of null removes that subtree.
 * Returns null when the tree is (and stays) absent.
 */
export async function simulatedTreeHash(
  root: string,
  treePath: string,
  overrides: ReadonlyMap<string, Sha256 | null>,
): Promise<Sha256 | null> {
  const abs = resolveInProject(root, treePath);
  const exists = pathKind(abs) === "dir";
  const entries = new Map<string, string>();
  if (exists) await listEntries(abs, "", entries);
  const base = treePath === "." ? "" : `${treePath}/`;
  let touched = false;
  for (const [key, hash] of overrides) {
    const parsed = parseKey(key);
    if (!parsed.path.startsWith(base) || parsed.path === treePath) continue;
    const rel = parsed.path.slice(base.length);
    if (isIgnoredRel(rel)) continue;
    touched = true;
    if (parsed.kind === "tree") {
      if (hash !== null) continue; // a restored nested tree can't be reconstructed here
      for (const entry of [...entries.keys()]) {
        if (entry === rel || entry.startsWith(`${rel}/`)) entries.delete(entry);
      }
    } else if (hash === null) {
      entries.delete(rel);
    } else {
      entries.set(rel, hash);
    }
  }
  if (!exists && !touched) return null;
  const lines = [...entries.keys()].sort(compareRel).map((rel) => `${rel}\0${entries.get(rel)}`);
  return sha256Of(lines.join("\n"));
}
