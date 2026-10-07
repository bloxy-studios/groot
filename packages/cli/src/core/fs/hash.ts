/** Content fingerprints in the contracts' `sha256:<hex>` form. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Sha256 } from "../contracts/common.ts";

export function sha256Of(content: string | Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as Sha256;
}

/** Hash of a file's bytes, or null when it doesn't exist (directories hash as null too). */
export async function hashFile(absPath: string): Promise<Sha256 | null> {
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return null;
    return sha256Of(await readFile(absPath));
  } catch {
    return null;
  }
}

export function hashFileSync(absPath: string): Sha256 | null {
  if (!existsSync(absPath)) return null;
  const info = statSync(absPath);
  if (!info.isFile()) return null;
  return sha256Of(readFileSync(absPath));
}

/**
 * Deterministic fingerprint of a directory tree (relative paths + file hashes,
 * sorted). `ignore` names are skipped at every level (node_modules, .git).
 */
export async function hashTree(
  absDir: string,
  ignore: readonly string[] = ["node_modules", ".git", ".groot", ".turbo"],
): Promise<Sha256 | null> {
  try {
    const info = await stat(absDir);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
  const entries: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const names = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of names) {
      if (ignore.includes(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        entries.push(`${rel}\0${sha256Of(await readFile(abs))}`);
      } else if (entry.isSymbolicLink()) {
        entries.push(`${rel}\0symlink`);
      }
    }
  }
  await walk(absDir, "");
  return sha256Of(entries.join("\n"));
}
