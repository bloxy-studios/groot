/**
 * Exact generator resolution with Bun's findBestVersion rule, against
 * fixture packuments (no network) — plus one live resolution of
 * create-hono@0.19, gated by GROOT_NETWORK_TESTS=1.
 */
import { describe, expect, test } from "bun:test";
import { GeneratorLock } from "../contracts/lock.ts";
import { GrootV2Error } from "../errors.ts";
import { findBestVersion, type Packument, registryPath, resolveSeries } from "./index.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function dist(name: string, version: string) {
  return {
    dist: {
      integrity: `sha512-${version}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    },
  };
}

const HONO: Packument = {
  "dist-tags": { latest: "0.19.5", next: "0.20.0-beta.1" },
  versions: Object.fromEntries(
    ["0.18.0", "0.19.0", "0.19.4", "0.19.5", "0.20.0-beta.1", "0.21.0"].map((version) => [
      version,
      dist("create-hono", version),
    ]),
  ),
};

/** latest sits outside the older series: the highest stable match must win. */
const NEXT: Packument = {
  "dist-tags": { latest: "16.4.0" },
  versions: Object.fromEntries(
    ["15.5.3", "15.5.10", "15.5.4", "15.6.0-canary.2", "16.4.0"].map((version) => [
      version,
      dist("create-next-app", version),
    ]),
  ),
};

function fakeFetch(
  respond: () => Response | Promise<Response>,
  calls: { url: string; accept: string | null }[] = [],
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
    return respond();
  };
  return impl as unknown as typeof fetch;
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function errorOf(promise: Promise<unknown>): Promise<GrootV2Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
  throw new Error("expected a GrootV2Error");
}

describe("findBestVersion (Bun's rule)", () => {
  test.each([
    ["exact version → that version", HONO, "0.19.4", "0.19.4"],
    ["exact version with = / v prefix", HONO, "=v0.19.4", "0.19.4"],
    ["exact version that was never published", HONO, "0.19.9", null],
    ["latest satisfies the series → latest", HONO, "0.19", "0.19.5"],
    ["latest wins over a higher match when it satisfies", HONO, ">=0.19.0", "0.19.5"],
    ["latest outside the series → highest stable match", NEXT, "15", "15.5.10"],
    ["prereleases are skipped for a stable range", NEXT, ">=15.6.0 <16", null],
    ["a range naming a prerelease may resolve to one", HONO, "^0.20.0-beta.0", "0.20.0-beta.1"],
    ["dist-tag name → the tagged version", HONO, "next", "0.20.0-beta.1"],
    ["unknown dist-tag → no match", HONO, "canary", null],
    ["x-ranges are ranges, not tags", HONO, "0.x", "0.19.5"],
    ["v-prefixed series are ranges, not tags", NEXT, "v15", "15.5.10"],
  ])("%s", (_label, packument, range, expected) => {
    // Arrange / Act
    const version = findBestVersion(packument, range);

    // Assert
    expect(version).toBe(expected);
  });

  test("scoped names are encoded as @scope%2fname", () => {
    // Arrange / Act / Assert
    expect(registryPath("@tanstack/cli")).toBe("@tanstack%2fcli");
    expect(registryPath("create-next-app")).toBe("create-next-app");
  });
});

describe("resolveSeries", () => {
  test("records version, integrity, tarball, time, and source from the registry", async () => {
    // Arrange
    const calls: { url: string; accept: string | null }[] = [];

    // Act
    const lock = await resolveSeries("create-hono", "0.19", {
      fetch: fakeFetch(() => jsonResponse(HONO), calls),
      now: NOW,
    });

    // Assert
    expect(GeneratorLock.safeParse(lock).success).toBe(true);
    expect(lock).toEqual({
      package: "create-hono",
      range: "0.19",
      version: "0.19.5",
      integrity: "sha512-0.19.5",
      tarball: "https://registry.npmjs.org/create-hono/-/create-hono-0.19.5.tgz",
      resolvedAt: NOW.toISOString(),
      source: "npm-registry",
      usedBy: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/create-hono");
    expect(calls[0]?.accept).toContain("application/vnd.npm.install-v1+json");
  });

  test("scoped packages hit the encoded URL", async () => {
    // Arrange
    const calls: { url: string; accept: string | null }[] = [];
    const packument = {
      "dist-tags": { latest: "0.69.2" },
      versions: { "0.69.2": dist("cli", "0.69.2") },
    };

    // Act
    const lock = await resolveSeries("@tanstack/cli", "0.69", {
      fetch: fakeFetch(() => jsonResponse(packument), calls),
      now: NOW,
    });

    // Assert
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/@tanstack%2fcli");
    expect(lock.version).toBe("0.69.2");
  });

  test.each([
    ["the request throws (offline)", () => Promise.reject(new TypeError("fetch failed"))],
    ["the registry answers 503", () => jsonResponse({ error: "unavailable" }, 503)],
    [
      "the body is not JSON (captive portal)",
      () => new Response("<html>login</html>", { status: 200 }),
    ],
    ["the body is not a packument", () => jsonResponse({ versions: "nope" })],
  ])("network trouble → unresolved with nulls when %s", async (_label, respond) => {
    // Arrange / Act
    const lock = await resolveSeries("create-hono", "0.19", {
      fetch: fakeFetch(respond),
      now: NOW,
    });

    // Assert
    expect(lock).toEqual({
      package: "create-hono",
      range: "0.19",
      version: null,
      integrity: null,
      tarball: null,
      resolvedAt: NOW.toISOString(),
      source: "unresolved",
      usedBy: [],
    });
  });

  test("definitive answers are errors: unknown package, no matching version, bad name", async () => {
    // Arrange
    const missing = resolveSeries("create-nothing", "1", {
      fetch: fakeFetch(() => jsonResponse({}, 404)),
    });
    const noMatch = resolveSeries("create-hono", "7", {
      fetch: fakeFetch(() => jsonResponse(HONO)),
    });
    const badName = resolveSeries("Not A Name", "1", {
      fetch: fakeFetch(() => jsonResponse(HONO)),
    });

    // Act
    const [missingError, noMatchError, badNameError] = [
      await errorOf(missing),
      await errorOf(noMatch),
      await errorOf(badName),
    ];

    // Assert
    expect(missingError.id).toBe("GROOT_E_NOT_FOUND");
    expect(noMatchError.id).toBe("GROOT_E_NOT_FOUND");
    expect(noMatchError.details).toMatchObject({
      package: "create-hono",
      range: "7",
      latest: "0.19.5",
    });
    expect(badNameError.id).toBe("GROOT_E_USAGE");
  });
});

describe("live registry (GROOT_NETWORK_TESTS=1)", () => {
  test.skipIf(process.env.GROOT_NETWORK_TESTS !== "1")(
    "resolves create-hono@0.19 to an exact, integrity-pinned 0.19.x",
    async () => {
      // Arrange / Act
      const lock = await resolveSeries("create-hono", "0.19");

      // Assert
      expect(lock.source).toBe("npm-registry");
      expect(lock.version).toMatch(/^0\.19\.\d+$/);
      expect(lock.integrity).toMatch(/^sha512-/);
      expect(lock.tarball).toContain(`create-hono-${lock.version}.tgz`);
    },
    60_000,
  );
});
