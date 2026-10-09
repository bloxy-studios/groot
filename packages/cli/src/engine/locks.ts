/**
 * Exact generator resolution for the scaffold pipeline: series pins
 * (`create-hono@0.19`) resolve to one exact version + registry integrity
 * before anything runs, generators are invoked as `bunx <pkg>@<exact>`, and
 * groot.lock.json records what produced each scaffold — one entry per
 * resolution, so a scaffold keeps the version it was generated with. An
 * unreachable registry never fails the run — the entry stays `unresolved`
 * and the series is used, which the lock states honestly.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { TRUNK_GENERATOR } from "../adapters/trunk.ts";
import { emptyLock, parseGeneratorSpec, readLock, serializeLock } from "../core/blueprint/index.ts";
import { type GeneratorLock, GrootLock } from "../core/contracts/lock.ts";
import { GrootV2Error } from "../core/errors.ts";
import { writeFileAtomic } from "../core/fs/atomic.ts";
import { resolveInProject } from "../core/fs/paths.ts";
import { nowIso } from "../core/ids.ts";
import { resolveSeries } from "../core/registry/index.ts";
import { EXIT, GrootError } from "./errors.ts";
import type { Plan } from "./types.ts";

const LOCK_FILE = "groot.lock.json";

const LOCK_HINT = `${LOCK_FILE} is written by groot — restore it from version control or resolve its merge conflict.`;

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
 * Resolve one series for a run. A definitive registry answer (no such
 * package, no version in the pinned series) means the generator cannot run —
 * the failure `bunx <pkg>@<series>` reported before resolution existed — so
 * init/add keep its v1 exit code: a generator failure, not a usage error.
 */
async function resolveForRun(
  name: string,
  range: string,
  fetchImpl: typeof fetch | undefined,
): Promise<GeneratorLock> {
  try {
    return await resolveSeries(name, range, { fetch: fetchImpl });
  } catch (error) {
    if (!(error instanceof GrootV2Error) || error.id !== "GROOT_E_NOT_FOUND") throw error;
    throw new GrootV2Error("GROOT_E_GENERATOR", error.message, {
      hint: error.hint,
      details: error.details ?? undefined,
    });
  }
}

/**
 * Resolve every generator the plan will run. A pin the registry definitively
 * refuses is a generator failure (EXIT.GENERATOR) — a pin that matches
 * nothing is a real defect; transient failures resolve to `unresolved`.
 */
export async function resolveGenerators(
  plan: Plan,
  options: { includeTrunk: boolean; fetch?: typeof fetch },
): Promise<GeneratorLock[]> {
  const locks: GeneratorLock[] = [];
  for (const [spec, usedBy] of specsOf(plan, options.includeTrunk)) {
    const { package: name, range } = parseGeneratorSpec(spec);
    locks.push({ ...(await resolveForRun(name, range, options.fetch)), usedBy });
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

/**
 * Refuse an unreadable groot.lock.json before anything is generated: stitch
 * updates the lock last, so finding it malformed, written by a newer groot,
 * or linked out of the workspace only then would leave a grown scaffold and
 * a rewritten groot.json behind. Throws readLock's GROOT_E_INVALID_DOCUMENT,
 * GROOT_E_UNSUPPORTED_SCHEMA, or GROOT_E_PATH_OUTSIDE_PROJECT (exit 2, with a
 * hint). v1 workspaces get no lock, so theirs is never read.
 */
export async function assertLockReadable(plan: Plan): Promise<void> {
  if ((plan.manifestVersion ?? 2) !== 2) return;
  // Only an existing directory holds a lock (init's target may not exist yet, or be a file in the way).
  if (!existsSync(plan.targetDir) || !statSync(plan.targetDir).isDirectory()) return;
  await readLock(plan.targetDir);
}

/** The same package + range resolved the same way: one exact version, or the series unresolved. */
function sameResolution(a: GeneratorLock, b: GeneratorLock): boolean {
  return (
    a.package === b.package &&
    a.range === b.range &&
    a.version === b.version &&
    a.integrity === b.integrity &&
    a.source === b.source
  );
}

/** Record `entry`'s paths on the entry with the same resolution, or append it. */
function upsert(list: readonly GeneratorLock[], entry: GeneratorLock): GeneratorLock[] {
  const index = list.findIndex((item) => sameResolution(item, entry));
  if (index === -1) return [...list, entry];
  return list.map((item, at) =>
    at === index ? { ...item, usedBy: [...new Set([...item.usedBy, ...entry.usedBy])] } : item,
  );
}

/**
 * Merge a run into the lock's generator entries, one entry per resolution —
 * a scaffold keeps the exact version (and integrity) it was generated with,
 * even after the same package + range resolves to something newer:
 * - paths generated now (`produced`) are recorded under the resolution that
 *   produced them, leaving any entry that claimed them before (an entry left
 *   without paths is dropped);
 * - paths the lock doesn't record yet (`carried`) are added as unresolved,
 *   never folded into an exact entry.
 */
function mergeGenerators(
  existing: readonly GeneratorLock[],
  produced: readonly GeneratorLock[],
  carried: readonly GeneratorLock[],
): GeneratorLock[] {
  let merged = [...existing];
  for (const entry of produced) {
    const moved = new Set(entry.usedBy);
    merged = merged.flatMap((item) => {
      if (sameResolution(item, entry)) return [item];
      const usedBy = item.usedBy.filter((path) => !moved.has(path));
      if (usedBy.length === item.usedBy.length) return [item];
      return usedBy.length > 0 ? [{ ...item, usedBy }] : [];
    });
    merged = upsert(merged, entry);
  }
  const recorded = new Set(merged.flatMap((item) => item.usedBy));
  for (const entry of carried) {
    const usedBy = entry.usedBy.filter((path) => !recorded.has(path));
    if (usedBy.length > 0) merged = upsert(merged, { ...entry, usedBy });
  }
  return merged;
}

/** An entry for scaffolds that ran without an exact resolution (offline, or not resolved by this run). */
function unresolvedEntry(spec: string, usedBy: string[]): GeneratorLock {
  const { package: name, range } = parseGeneratorSpec(spec);
  return {
    package: name,
    range,
    version: null,
    integrity: null,
    tarball: null,
    resolvedAt: nowIso(),
    source: "unresolved",
    usedBy,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * groot.lock.json's location — resolved inside the workspace, so a link
 * leading out of it is refused — and its current text and contents. Any
 * failure is a stitch failure naming the file; the tree stays in place.
 */
function currentLock(root: string): { file: string; text: string | null; lock: GrootLock } {
  let file: string;
  try {
    file = resolveInProject(root, LOCK_FILE);
  } catch (error) {
    throw new GrootError(
      `Stitch failed: ${messageOf(error)}`,
      EXIT.STITCH,
      error instanceof GrootError ? error.hint : undefined,
    );
  }
  if (!existsSync(file)) return { file, text: null, lock: emptyLock() };
  let text: string;
  let parsed: ReturnType<typeof GrootLock.safeParse>;
  try {
    text = readFileSync(file, "utf8");
    parsed = GrootLock.safeParse(JSON.parse(text));
  } catch (error) {
    throw new GrootError(
      `Stitch failed: could not parse ${LOCK_FILE} (${messageOf(error)})`,
      EXIT.STITCH,
      LOCK_HINT,
    );
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at =
      issue === undefined || issue.path.length === 0
        ? "(document)"
        : issue.path.map(String).join(".");
    throw new GrootError(
      `Stitch failed: ${LOCK_FILE} is not a lock this groot reads — ${at}: ${issue?.message ?? "invalid value"}`,
      EXIT.STITCH,
      LOCK_HINT,
    );
  }
  return { file, text, lock: parsed.data };
}

/**
 * Write or update groot.lock.json for a v2 workspace (v1 workspaces never get
 * one — no implicit migration). Returns a stitch note, or null when unchanged.
 * The write replaces the file atomically and never follows a link.
 */
export function stitchLock(plan: Plan, root: string = plan.targetDir): string | null {
  if ((plan.manifestVersion ?? 2) !== 2) return null;
  const { file, text: current, lock: base } = currentLock(root);
  const produced = plan.generatorLocks ?? [];
  const producedPaths = new Set(produced.flatMap((lock) => lock.usedBy));
  // Scaffolds this run didn't resolve (existing ones, dry or offline paths) are still recorded honestly.
  const carried = [...specsOf(plan, false)].flatMap(([spec, paths]) => {
    const usedBy = paths.filter((path) => !producedPaths.has(path));
    return usedBy.length === 0 ? [] : [unresolvedEntry(spec, usedBy)];
  });
  const next: GrootLock = {
    ...base,
    generators: mergeGenerators(base.generators, produced, carried),
  };
  const text = serializeLock(next);
  if (text === current) return null;
  writeFileAtomic(file, text);
  const exact = next.generators.filter((entry) => entry.version !== null).length;
  return `${LOCK_FILE} → ${next.generators.length} generator(s) recorded (${exact} exact)`;
}
