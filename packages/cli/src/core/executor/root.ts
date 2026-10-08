/**
 * Project-root discovery for v2 commands that act on an existing project
 * (apply, resume, rollback, status, …). A project is marked by its blueprint
 * (`groot.json`) or by Groot's local state directory (`.groot/`) — the latter
 * covers projects that have operations but no blueprint yet (e.g. a plan
 * applied before adoption registered the project).
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR_NAME } from "../state.ts";

function isProjectMarker(dir: string): boolean {
  if (existsSync(join(dir, "groot.json"))) return true;
  try {
    return statSync(join(dir, STATE_DIR_NAME)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` to the nearest directory containing `groot.json` or
 * `.groot/`. Returns its absolute path, or null when no ancestor qualifies.
 */
export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  for (;;) {
    if (isProjectMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
