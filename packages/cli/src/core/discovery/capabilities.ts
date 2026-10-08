/**
 * Likely capabilities, inferred from declared dependencies only: an auth
 * library or a data layer a unit already uses. These are observations, not
 * blueprint capabilities — Groot didn't add them — but the planner and the
 * compatibility solver use them to refuse layering a second auth or data
 * setup on top of an existing one.
 */
import type { Sha256 } from "../contracts/common.ts";
import type { FactFactory, ObservedFact } from "./facts.ts";

export interface CapabilityObservationValue {
  capability: string;
  provider: string;
  unit: string;
  evidence: string;
}

interface ProviderRule {
  readonly capability: "auth" | "data";
  readonly provider: string;
  readonly match: (pkg: string) => boolean;
}

const exact =
  (...names: string[]) =>
  (pkg: string): boolean =>
    names.includes(pkg);
const scope =
  (prefix: string) =>
  (pkg: string): boolean =>
    pkg.startsWith(`${prefix}/`);

const PROVIDERS: readonly ProviderRule[] = [
  { capability: "auth", provider: "better-auth", match: exact("better-auth") },
  { capability: "auth", provider: "next-auth", match: exact("next-auth") },
  { capability: "auth", provider: "authjs", match: exact("@auth/core") },
  { capability: "auth", provider: "clerk", match: scope("@clerk") },
  { capability: "auth", provider: "lucia", match: exact("lucia") },
  { capability: "auth", provider: "supabase", match: exact("@supabase/ssr") },
  { capability: "auth", provider: "workos", match: scope("@workos-inc") },
  { capability: "data", provider: "drizzle", match: exact("drizzle-orm") },
  { capability: "data", provider: "prisma", match: exact("@prisma/client", "prisma") },
  { capability: "data", provider: "convex", match: exact("convex") },
  { capability: "data", provider: "supabase", match: exact("@supabase/supabase-js") },
  { capability: "data", provider: "mongoose", match: exact("mongoose") },
  { capability: "data", provider: "kysely", match: exact("kysely") },
  { capability: "data", provider: "typeorm", match: exact("typeorm") },
  { capability: "data", provider: "libsql", match: exact("@libsql/client") },
  { capability: "data", provider: "pg", match: exact("pg") },
  { capability: "data", provider: "mysql2", match: exact("mysql2") },
];

export interface DependencySource {
  readonly unit: string;
  /** Project path of the manifest the dependencies were read from. */
  readonly manifest: string;
  readonly fingerprint: Sha256 | null;
  readonly declared: Readonly<Record<string, string>>;
}

/** One observation per (unit, capability, provider), evidence listing the packages. */
export function observeCapabilities(
  sources: readonly DependencySource[],
  fact: FactFactory,
): ObservedFact<CapabilityObservationValue>[] {
  const observations: ObservedFact<CapabilityObservationValue>[] = [];
  for (const source of sources) {
    for (const rule of PROVIDERS) {
      const packages = Object.keys(source.declared).filter(rule.match).sort();
      if (packages.length === 0) continue;
      observations.push(
        fact({
          value: {
            capability: rule.capability,
            provider: rule.provider,
            unit: source.unit,
            evidence: `declares ${packages.map((name) => `${name}@${source.declared[name]}`).join(", ")}`,
          },
          source: source.manifest,
          method: "manifest",
          confidence: "high",
          fingerprint: source.fingerprint,
        }),
      );
    }
  }
  return observations;
}
