/**
 * Regenerate the published JSON Schemas from the zod contracts
 * (packages/cli/src/core/contracts). Run after changing a contract:
 *
 *   bun scripts/generate-schemas.ts          # write schemas/
 *   bun scripts/generate-schemas.ts --check  # exit 1 if any file is stale
 *
 * The contracts test runs the same comparison, so CI fails on drift.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderSchemaFiles } from "../packages/cli/src/core/contracts/render.ts";

const repoRoot = join(import.meta.dir, "..");
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const file of renderSchemaFiles()) {
  const absolute = join(repoRoot, file.path);
  let current: string | null = null;
  try {
    current = readFileSync(absolute, "utf8");
  } catch {
    current = null;
  }
  if (current === file.content) continue;
  if (check) {
    stale.push(file.path);
    continue;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, file.content);
  console.log(`wrote ${file.path}`);
}

if (check && stale.length > 0) {
  console.error(`Stale schemas (run bun scripts/generate-schemas.ts):\n${stale.join("\n")}`);
  process.exit(1);
}
