/**
 * Exact generator resolution for the scaffold pipeline: series pins
 * (`create-hono@0.19`) resolve to one exact version + registry integrity
 * before anything runs, generators are invoked as `bunx <pkg>@<exact>`, and
 * groot.lock.json records what produced each scaffold. An unreachable
 * registry never fails the run — the entry stays `unresolved` and the series
 * is used, which the lock states honestly.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRUNK_GENERATOR } from "../adapters/trunk.ts";
import { emptyLock, parseGeneratorSpec, serializeLock } from "../core/blueprint/index.ts";
import { type GeneratorLock, GrootLock } from "../core/contracts/lock.ts";
import { nowIso } from "../core/ids.ts";
import { resolveSeries } from "../core/registry/index.ts";
import type { Plan } from "./types.ts";

const LOCK_FILE = "groot.lock.json";

/** Which scaffold paths used each generator spec ("." = the trunk / single-app root). */
function specsOf(plan: Plan, includeTrunk: boolean): Map<string, string[]> {
  const specs = new Map<string, string[]>();
  if (includeTrunk) specs.set(TRUNK_GENERATOR, ["."]);
  for (const scaffold of plan.scaffolds) {
    if (scaffold.generator === null) continue;
    specs.set(scaffold.generator, [...(specs.get(scaffold.generator) ?? []), scaffold.path]);
  }
  return specs;
}

/**
 * Resolve every generator the plan will run. Definitive registry answers
 * (no such package/version) propagate as errors — a pin that matches
 * nothing is a real defect; transient failures resolve to `unresolved`.
 */
export async function resolveGenerators(
  plan: Plan,
  options: { includeTrunk: boolean; fetch?: typeof fetch },
): Promise<GeneratorLock[]> {
  const locks: GeneratorLock[] = [];
  for (const [spec, usedBy] of specsOf(plan, options.includeTrunk)) {
    const { package: name, range } = parseGeneratorSpec(spec);
    const resolved = await resolveSeries(name, range, { fetch: options.fetch });
    locks.push({ ...resolved, usedBy });
  }
  return locks;
}

/** Rewrite `pkg@series` argv tokens to the locked exact versions. */
export function exactArgv(
  argv: readonly string[],
  locks: readonly GeneratorLock[] | undefined,
): string[] {
  if (locks === undefined || locks.length === 0) return [...argv];
  return argv.map((token) => {
    const lock = locks.find((entry) => token === `${entry.package}@${entry.range}`);
    return lock?.version ? `${lock.package}@${lock.version}` : token;
  });
}

/** Merge generator entries: same package + range → one entry with combined usedBy (newest resolution wins). */
function mergeGenerators(
  existing: readonly GeneratorLock[],
  added: readonly GeneratorLock[],
): GeneratorLock[] {
  const merged = [...existing];
  for (const entry of added) {
    const index = merged.findIndex(
      (item) => item.package === entry.package && item.range === entry.range,
    );
    if (index === -1) {
      merged.push(entry);
      continue;
    }
    const current = merged[index] as GeneratorLock;
    merged[index] = {
      ...(entry.version !== null ? entry : current),
      usedBy: [...new Set([...current.usedBy, ...entry.usedBy])],
    };
  }
  return merged;
}

/**
 * Write or update groot.lock.json for a v2 workspace (v1 workspaces never get
 * one — no implicit migration). Returns a stitch note, or null when unchanged.
 */
export function stitchLock(plan: Plan, root: string = plan.targetDir): string | null {
  if ((plan.manifestVersion ?? 2) !== 2) return null;
  const path = join(root, LOCK_FILE);
  const resolved = plan.generatorLocks ?? [];
  const unresolved = specsOf(plan, false);
  // Scaffolds without a resolution (e.g. dry or offline paths) are still recorded honestly.
  const fallback: GeneratorLock[] = [...unresolved]
    .filter(([spec]) => !resolved.some((lock) => `${lock.package}@${lock.range}` === spec))
    .map(([spec, usedBy]) => {
      const { package: name, range } = parseGeneratorSpec(spec);
      return {
        package: name,
        range,
        version: null,
        integrity: null,
        tarball: null,
        resolvedAt: nowIso(),
        source: "unresolved" as const,
        usedBy,
      };
    });
  const base = existsSync(path)
    ? GrootLock.parse(JSON.parse(readFileSync(path, "utf8")))
    : emptyLock();
  const next: GrootLock = {
    ...base,
    generators: mergeGenerators(base.generators, [...resolved, ...fallback]),
  };
  const text = serializeLock(next);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return null;
  writeFileSync(path, text);
  const exact = next.generators.filter((entry) => entry.version !== null).length;
  return `${LOCK_FILE} → ${next.generators.length} generator(s) recorded (${exact} exact)`;
}
