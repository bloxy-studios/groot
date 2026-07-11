/**
 * Upstream drift watch — the pin & doc half of groot's drift detection
 * (runbook: docs/maintainers.md#upstream-drift-watch).
 *
 * The weekly e2e cron catches BEHAVIOR drift: a pinned generator whose output
 * changed under us. This script catches what E2E can't see:
 *
 * - a new series published upstream that groot's pins silently ignore
 *   (create-next-app 17 while we pin @16, sv 0.17 while we pin @0.16, …)
 * - the same for the Expo SDK template line and the dependency ranges
 *   groot-authored packages ship with (Elysia / Convex templates)
 * - docs/scaffold-flows.md's "Last verified" date exceeding its budget
 *
 * Dependency-free: bun builtins + workspace source imports (the pins are read
 * from the same modules the CLI executes, so the checker can never drift from
 * reality). With GITHUB_TOKEN set it upserts a single `upstream-drift`-labeled
 * issue, updated in place via a body fingerprint and closed when drift clears;
 * without a token it prints the report. Registry failures fail the run instead
 * of filing issues.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexPackageJson } from "../packages/cli/src/adapters/convex.ts";
import { elysiaPackageJson } from "../packages/cli/src/adapters/elysia.ts";
import { EXPO_TEMPLATE } from "../packages/cli/src/adapters/expo.ts";
import { TRUNK_GENERATOR } from "../packages/cli/src/adapters/trunk.ts";
import { MATRIX, SLOT_ORDER } from "../packages/cli/src/engine/matrix.ts";

/** How old scaffold-flows.md's "Last verified" date may grow before we nudge. */
export const DOC_AGE_BUDGET_DAYS = 90;

/**
 * Intentional pin lags — suppressed from findings but reported in their own
 * section so reviewers see them. Keep every entry justified.
 */
export const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "typescript",
    "scaffolded packages track the upstream templates (Convex, Elysia docs), which are still on TypeScript 5 — revisit when upstream templates move",
  ],
  ["@types/node", "pin tracks the upstream Convex template (get-convex/templates)"],
]);

export interface PinnedPackage {
  readonly name: string;
  /** The series groot pins: a major ("16") or a 0.x minor ("0.19"). */
  readonly series: string;
  /** Where the pin lives, for the report. */
  readonly source: string;
}

export interface Finding extends PinnedPackage {
  readonly latest: string;
}

export interface DriftReport {
  readonly findings: readonly Finding[];
  readonly suppressed: readonly (Finding & { reason: string })[];
  /** Non-package findings (doc staleness, self-checks). */
  readonly notes: readonly string[];
  readonly body: string;
  readonly fingerprint: string;
}

/** Split a "name@series" pin (scoped names keep their leading @). */
export function parsePin(pin: string): { name: string; series: string } {
  const at = pin.lastIndexOf("@");
  if (at <= 0) throw new Error(`not a name@series pin: "${pin}"`);
  return { name: pin.slice(0, at), series: pin.slice(at + 1) };
}

/**
 * The breaking-change series of a version: its major, or "0.<minor>" for 0.x
 * (semver treats 0.x minors as breaking — sv and create-hono live there).
 */
export function seriesOf(version: string): string {
  const [major = "0", minor = "0"] = version.split(".");
  return major === "0" ? `0.${minor}` : major;
}

/** The series a dependency range pins, or null for unpinnable ranges (`*`, workspace). */
export function rangeSeries(range: string): string | null {
  const cleaned = range.trim().replace(/^[\^~>=v\s]+/, "");
  if (cleaned.length === 0 || cleaned === "*" || range.includes("workspace:")) return null;
  if (!/^\d/.test(cleaned)) return null;
  return seriesOf(cleaned);
}

/** Extract "Last verified: YYYY-MM-DD" from scaffold-flows.md, or null. */
export function parseVerifiedDate(markdown: string): string | null {
  const match = markdown.match(/Last verified: (\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

/** Whole days between an ISO date and now. */
export function daysSince(isoDate: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(`${isoDate}T00:00:00Z`).getTime()) / 86_400_000);
}

function depPins(packageJson: string, source: string): PinnedPackage[] {
  const parsed = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pins: PinnedPackage[] = [];
  for (const [name, range] of Object.entries({
    ...parsed.dependencies,
    ...parsed.devDependencies,
  })) {
    const series = rangeSeries(range);
    if (series !== null) pins.push({ name, series, source });
  }
  return pins;
}

/**
 * Every pinned series groot ships, read from the modules the CLI executes.
 * Returns pins plus self-check notes (e.g. an unparseable Expo template tag).
 */
export function collectPinnedPackages(): { pins: PinnedPackage[]; notes: string[] } {
  const pins: PinnedPackage[] = [];
  const notes: string[] = [];

  const trunk = parsePin(TRUNK_GENERATOR);
  pins.push({ ...trunk, source: "trunk generator pin (adapters/trunk.ts)" });

  for (const slot of SLOT_ORDER) {
    for (const choice of MATRIX[slot].choices) {
      if (choice.generator === null) continue;
      const pin = parsePin(choice.generator);
      pins.push({ ...pin, source: `${choice.label} generator pin (engine/matrix.ts)` });
    }
  }

  const sdk = EXPO_TEMPLATE.match(/sdk-(\d+)/);
  if (sdk?.[1] !== undefined) {
    pins.push({
      name: "expo",
      series: sdk[1],
      source: `Expo SDK template tag "${EXPO_TEMPLATE}" (adapters/expo.ts)`,
    });
  } else {
    notes.push(
      `self-check: could not parse an SDK line from EXPO_TEMPLATE "${EXPO_TEMPLATE}" — update scripts/check-upstream-drift.ts alongside the adapter.`,
    );
  }

  pins.push(
    ...depPins(elysiaPackageJson("api"), "Elysia template dependency (adapters/elysia.ts)"),
  );
  pins.push(
    ...depPins(
      convexPackageJson("@repo/backend"),
      "Convex template dependency (adapters/convex.ts)",
    ),
  );

  // De-duplicate identical name+series pins from different sources.
  const seen = new Map<string, PinnedPackage>();
  for (const pin of pins) {
    const key = `${pin.name}@${pin.series}`;
    if (!seen.has(key)) seen.set(key, pin);
  }
  return { pins: [...seen.values()], notes };
}

/** Compare every pin against the registry's latest dist-tag. */
export async function checkPins(
  pins: readonly PinnedPackage[],
  fetchLatest: (name: string) => Promise<string>,
): Promise<{ findings: Finding[]; suppressed: (Finding & { reason: string })[] }> {
  const findings: Finding[] = [];
  const suppressed: (Finding & { reason: string })[] = [];
  for (const pin of pins) {
    const latest = await fetchLatest(pin.name);
    if (seriesOf(latest) === pin.series) continue;
    const finding: Finding = { ...pin, latest };
    const reason = ALLOWLIST.get(pin.name);
    if (reason !== undefined) suppressed.push({ ...finding, reason });
    else findings.push(finding);
  }
  return { findings, suppressed };
}

/** Assemble the (deterministic) issue body + fingerprint. */
export function buildReport(
  findings: readonly Finding[],
  suppressed: readonly (Finding & { reason: string })[],
  notes: readonly string[],
): DriftReport {
  const sortByName = <T extends Finding>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const sortedFindings = sortByName(findings);
  const sortedSuppressed = sortByName(suppressed);

  const lines: string[] = [];
  if (sortedFindings.length > 0) {
    lines.push(
      "## 🌪 Upstream drift detected",
      "",
      "| package | pinned series | latest upstream | pinned where |",
      "| --- | --- | --- | --- |",
      ...sortedFindings.map(
        (f) => `| \`${f.name}\` | \`${f.series}\` | \`${f.latest}\` | ${f.source} |`,
      ),
      "",
      "**What to do:** re-verify the affected section of `docs/scaffold-flows.md` against upstream, bump the pin in its adapter, and land both in the same PR (CLAUDE.md rule). Behavior drift is covered separately by the weekly e2e cron.",
    );
  }
  for (const note of notes) {
    lines.push("", `⚠️ ${note}`);
  }
  if (sortedSuppressed.length > 0) {
    lines.push(
      "",
      "<details><summary>Allowlisted pin lags (intentional — review the reasons)</summary>",
      "",
      ...sortedSuppressed.map(
        (f) => `- \`${f.name}\`: pinned \`${f.series}\`, latest \`${f.latest}\` — ${f.reason}`,
      ),
      "",
      "</details>",
    );
  }

  const fingerprint = Bun.hash(
    JSON.stringify([sortedFindings.map((f) => [f.name, f.series, seriesOf(f.latest)]), notes]),
  ).toString(36);
  lines.push("", `<!-- drift-fingerprint:${fingerprint} -->`);
  return {
    findings: sortedFindings,
    suppressed: sortedSuppressed,
    notes,
    body: lines.join("\n"),
    fingerprint,
  };
}

/** Latest dist-tag from the npm registry (abbreviated metadata). */
async function fetchLatestVersion(name: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  const meta = (await res.json()) as { "dist-tags"?: Record<string, string> };
  const latest = meta["dist-tags"]?.latest;
  if (latest === undefined) throw new Error(`no latest dist-tag for ${name}`);
  return latest;
}

const LABEL = "upstream-drift";

interface GithubIssue {
  readonly number: number;
  readonly body: string | null;
  readonly pull_request?: unknown;
}

/** Create/update/close the single drift issue, idempotently via the fingerprint. */
async function upsertIssue(report: DriftReport, repo: string, token: string): Promise<void> {
  const api = async (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

  // Ensure the label exists (422 = already there).
  const labelRes = await api("/labels", {
    method: "POST",
    body: JSON.stringify({
      name: LABEL,
      color: "d93f0b",
      description: "Automated upstream pin/doc drift report",
    }),
  });
  if (!labelRes.ok && labelRes.status !== 422) {
    throw new Error(`label ensure failed: ${labelRes.status}`);
  }

  const listRes = await api(`/issues?labels=${LABEL}&state=open&per_page=10`);
  if (!listRes.ok) throw new Error(`issue list failed: ${listRes.status}`);
  const open = ((await listRes.json()) as GithubIssue[]).filter(
    (issue) => issue.pull_request === undefined,
  );
  const existing = open.at(0);
  const hasDrift = report.findings.length > 0 || report.notes.length > 0;

  if (!hasDrift) {
    if (existing !== undefined) {
      await api(`/issues/${existing.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "Drift cleared on the latest check — closing. 🌱" }),
      });
      await api(`/issues/${existing.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
      console.log(`all clear — closed #${existing.number}`);
    } else {
      console.log("all clear — no drift, no open issue");
    }
    return;
  }

  if (existing === undefined) {
    const createRes = await api("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: "🌪 Upstream drift detected (automated watch)",
        body: report.body,
        labels: [LABEL],
      }),
    });
    if (!createRes.ok) throw new Error(`issue create failed: ${createRes.status}`);
    const created = (await createRes.json()) as GithubIssue;
    console.log(`drift found — opened #${created.number}`);
    return;
  }

  if (existing.body?.includes(`drift-fingerprint:${report.fingerprint}`) === true) {
    console.log(`drift unchanged — #${existing.number} already up to date`);
    return;
  }
  const patchRes = await api(`/issues/${existing.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: report.body }),
  });
  if (!patchRes.ok) throw new Error(`issue update failed: ${patchRes.status}`);
  await api(`/issues/${existing.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "The drift picture changed — body updated by the latest check." }),
  });
  console.log(`drift changed — updated #${existing.number}`);
}

async function main(): Promise<void> {
  const { pins, notes } = collectPinnedPackages();
  console.log(`checking ${pins.length} pinned series…`);

  const errors: string[] = [];
  const { findings, suppressed } = await checkPins(pins, async (name) => {
    try {
      return await fetchLatestVersion(name);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return "0.0.0-registry-error";
    }
  });
  if (errors.length > 0) {
    // Infra problems fail the run visibly instead of filing misleading issues.
    console.error(`registry errors:\n${errors.join("\n")}`);
    process.exit(1);
  }

  const flows = readFileSync(join(import.meta.dir, "../docs/scaffold-flows.md"), "utf8");
  const verified = parseVerifiedDate(flows);
  if (verified === null) {
    notes.push(
      "self-check: docs/scaffold-flows.md has no parseable “Last verified: YYYY-MM-DD” header.",
    );
  } else {
    const age = daysSince(verified);
    if (age > DOC_AGE_BUDGET_DAYS) {
      notes.push(
        `docs/scaffold-flows.md was last verified ${age} days ago (${verified}) — budget is ${DOC_AGE_BUDGET_DAYS} days. Re-verify the generator facts and refresh the date.`,
      );
    }
  }

  const report = buildReport(findings, suppressed, notes);
  console.log(report.body);

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not a turbo task — drift.yml runs this standalone
  const token = process.env.GITHUB_TOKEN;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not a turbo task — drift.yml runs this standalone
  const repo = process.env.GITHUB_REPOSITORY;
  if (token !== undefined && token.length > 0 && repo !== undefined && repo.length > 0) {
    await upsertIssue(report, repo, token);
  } else {
    console.log("(no GITHUB_TOKEN/GITHUB_REPOSITORY — report printed only)");
  }
}

if (import.meta.main) {
  await main();
}
