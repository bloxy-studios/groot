/**
 * Exact generator resolution (docs/v2-architecture.md#capabilities-and-recipes):
 * a series pin such as `create-next-app@16` resolves to one exact version
 * plus its registry integrity, so generators run as `bunx <pkg>@<exact>` and
 * groot.lock.json can say precisely what produced a scaffold.
 *
 * The choice mirrors Bun's own resolver (findBestVersion in Bun's npm
 * client) so Groot locks what `bun install` would pick for the same range:
 *   1. an exact version spec → that version;
 *   2. otherwise `dist-tags.latest`, when it satisfies the range and the
 *      range names no prerelease;
 *   3. otherwise the highest non-prerelease version satisfying the range
 *      (prereleases are candidates only when the range itself names one).
 * A dist-tag name ("latest", "next") resolves through the tag.
 *
 * Network trouble never fails planning: an unreachable registry yields
 * `source: "unresolved"` with null fields (the lock stays honest about it).
 * A registry that answers definitively — no such package, no matching
 * version — is GROOT_E_NOT_FOUND, because a pin that matches nothing is a
 * real defect to surface, not a transient condition to paper over. (`init`
 * and `add` report it as the generator failure it is for them — exit 4, see
 * engine/locks.ts.)
 */
import { z } from "zod";
import type { GeneratorLock } from "../contracts/lock.ts";
import { GrootV2Error } from "../errors.ts";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

const FETCH_TIMEOUT_MS = 15_000;

/** Abbreviated metadata: dist-tags + per-version dist, far smaller than the full packument. */
const ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_VERSION = /^[=v]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;
/** Words that look like tags but are ranges: x-ranges ("x", "x.x", "X.1") and v-prefixed versions ("v16"). */
const RANGE_WORD = /^(?:[xX*](?:\.(?:[xX*]|\d+))*|[vV]\d.*)$/;
const PRERELEASE_IN_RANGE = /\d+\.\d+\.\d+-[0-9A-Za-z]/;

/** Untrusted registry data: only the fields resolution reads are validated. */
export const Packument = z.looseObject({
  "dist-tags": z.record(z.string(), z.string()).optional(),
  versions: z
    .record(
      z.string(),
      z.looseObject({
        dist: z
          .looseObject({ integrity: z.string().optional(), tarball: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});
export type Packument = z.infer<typeof Packument>;

export interface ResolveOptions {
  /** Injectable fetch (tests use fixture packuments). */
  readonly fetch?: typeof fetch;
  /** Clock for `resolvedAt`. */
  readonly now?: Date;
}

function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

function satisfies(version: string, range: string): boolean {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

/** Bun's findBestVersion over a packument; null when nothing matches. */
export function findBestVersion(packument: Packument, range: string): string | null {
  const versions = Object.keys(packument.versions ?? {});
  const tags = packument["dist-tags"] ?? {};
  const spec = range.trim();
  const exact = EXACT_VERSION.exec(spec)?.[1];
  if (exact !== undefined) return versions.includes(exact) ? exact : null;
  // Bun.semver treats an unknown word like "latest" as "*"; npm semantics say dist-tag.
  if (DIST_TAG.test(spec) && !RANGE_WORD.test(spec)) {
    const tagged = tags[spec];
    return tagged !== undefined && versions.includes(tagged) ? tagged : null;
  }
  const allowPrerelease = PRERELEASE_IN_RANGE.test(spec);
  const latest = tags.latest;
  if (!allowPrerelease && latest !== undefined && versions.includes(latest)) {
    if (satisfies(latest, spec)) return latest;
  }
  const candidates = versions
    .filter((version) => (allowPrerelease || !isPrerelease(version)) && satisfies(version, spec))
    .sort((a, b) => Bun.semver.order(b, a));
  return candidates[0] ?? null;
}

/** Registry URL path for a package (`@scope/name` → `@scope%2fname`). */
export function registryPath(name: string): string {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const slash = name.indexOf("/");
  return `@${encodeURIComponent(name.slice(1, slash))}%2f${encodeURIComponent(name.slice(slash + 1))}`;
}

type Fetched =
  | { readonly kind: "ok"; readonly packument: Packument }
  | { readonly kind: "missing" }
  | { readonly kind: "unreachable" };

async function fetchPackument(name: string, fetchImpl: typeof fetch): Promise<Fetched> {
  let response: Response;
  try {
    response = await fetchImpl(`${NPM_REGISTRY_URL}/${registryPath(name)}`, {
      headers: { accept: ACCEPT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "unreachable" };
  try {
    const parsed = Packument.safeParse(await response.json());
    return parsed.success ? { kind: "ok", packument: parsed.data } : { kind: "unreachable" };
  } catch {
    // A captive portal or proxy error page is a connectivity problem, not an answer.
    return { kind: "unreachable" };
  }
}

/**
 * Resolve a generator series (`create-hono`, `0.19`) to an exact, integrity-
 * pinned lock entry. `usedBy` is left empty for the caller to fill.
 */
export async function resolveSeries(
  pkg: string,
  range: string,
  opts: ResolveOptions = {},
): Promise<GeneratorLock> {
  if (!PACKAGE_NAME.test(pkg)) {
    throw new GrootV2Error("GROOT_E_USAGE", `"${pkg}" is not a valid npm package name.`, {
      details: { package: pkg },
    });
  }
  const resolvedAt = (opts.now ?? new Date()).toISOString();
  const fetched = await fetchPackument(pkg, opts.fetch ?? fetch);
  if (fetched.kind === "unreachable") {
    return {
      package: pkg,
      range,
      version: null,
      integrity: null,
      tarball: null,
      resolvedAt,
      source: "unresolved",
      usedBy: [],
    };
  }
  if (fetched.kind === "missing") {
    throw new GrootV2Error("GROOT_E_NOT_FOUND", `The npm registry has no package "${pkg}".`, {
      hint: "Check the generator pin (package name) in the adapter or groot.json.",
      details: { package: pkg, range },
    });
  }
  const version = findBestVersion(fetched.packument, range);
  if (version === null) {
    const latest = fetched.packument["dist-tags"]?.latest ?? null;
    throw new GrootV2Error(
      "GROOT_E_NOT_FOUND",
      `No published version of ${pkg} matches "${range}"${latest === null ? "" : ` (latest is ${latest})`}.`,
      {
        hint: "The pinned series no longer exists upstream — update the pin.",
        details: { package: pkg, range, latest },
      },
    );
  }
  const dist = fetched.packument.versions?.[version]?.dist;
  return {
    package: pkg,
    range,
    version,
    integrity: dist?.integrity ?? null,
    tarball: dist?.tarball ?? null,
    resolvedAt,
    source: "npm-registry",
    usedBy: [],
  };
}
