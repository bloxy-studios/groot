/**
 * Task-scoped context (`groot context --task "…"`): only the apps, commands,
 * environment NAMES, decisions, acceptance checks, evidence, and known gaps
 * that bear on the task — with the sources each came from — instead of a
 * growing transcript. Relevance is deterministic keyword matching against
 * app identity, kind, framework, capabilities, and consumed variables, with
 * synonym groups for common task vocabulary.
 */
import type { BlueprintV2 } from "../contracts/blueprint.ts";
import { schemaUrl } from "../contracts/common.ts";
import type { TaskContext } from "../contracts/context.ts";
import { CANCELLED_REASON, type Evidence } from "../contracts/evidence.ts";
import type { ProjectObservation } from "../contracts/project.ts";
import { missingRequiredEnv } from "../env.ts";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "add",
  "make",
  "new",
  "use",
  "should",
  "when",
  "then",
  "than",
  "have",
  "has",
  "can",
  "our",
  "your",
  "all",
  "any",
  "not",
]);

/** Task vocabulary → what it implies about relevant apps. */
const SYNONYMS: readonly {
  words: readonly string[];
  kinds?: readonly string[];
  capability?: string;
}[] = [
  {
    words: ["api", "endpoint", "route", "server", "backend", "handler", "rest"],
    kinds: ["api", "backend"],
  },
  {
    words: ["page", "ui", "frontend", "web", "component", "screen", "form", "button"],
    kinds: ["web"],
  },
  { words: ["mobile", "ios", "android", "expo"], kinds: ["mobile"] },
  { words: ["desktop", "electron", "tauri"], kinds: ["desktop"] },
  {
    words: [
      "auth",
      "login",
      "logout",
      "signin",
      "signup",
      "sign",
      "session",
      "account",
      "user",
      "users",
      "password",
    ],
    capability: "auth",
  },
  {
    words: [
      "database",
      "db",
      "table",
      "persist",
      "persistence",
      "migration",
      "schema",
      "query",
      "data",
      "sql",
      "drizzle",
    ],
    capability: "data",
  },
];

function tokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 2 && !STOPWORDS.has(word)),
    ),
  ];
}

interface Scored {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly framework: string | null;
  readonly entry: string | null;
  readonly relevance: number;
  readonly why: string;
}

function scoreApps(
  blueprint: BlueprintV2 | null,
  observation: ProjectObservation,
  task: string | null,
): Scored[] {
  const apps =
    blueprint?.apps.map((app) => ({
      id: app.id,
      path: app.path,
      kind: app.kind,
      framework: app.framework,
      entry: app.entry,
    })) ??
    observation.units.map((unit) => ({
      id: unit.id,
      path: unit.path,
      kind: unit.kind.value,
      framework: unit.framework.value?.id ?? null,
      entry: unit.entry.value,
    }));
  if (task === null || task.trim() === "") {
    return apps.map((app) => ({ ...app, relevance: 1, why: "no task given — whole project" }));
  }
  const words = tokens(task);
  return apps.map((app) => {
    const capabilities =
      blueprint?.capabilities.filter((entry) => entry.target === app.id).map((entry) => entry.id) ??
      [];
    const envNames =
      blueprint?.environment
        .filter((entry) => entry.consumer === app.path)
        .map((entry) => entry.name.toLowerCase()) ?? [];
    const haystack = new Set(
      tokens(
        [app.id, app.path, app.kind, app.framework ?? "", ...capabilities, ...envNames].join(" "),
      ),
    );
    const reasons: string[] = [];
    let score = 0;
    for (const word of words) {
      if (haystack.has(word)) {
        score += 1;
        reasons.push(`mentions "${word}"`);
      }
      for (const group of SYNONYMS) {
        if (!group.words.includes(word)) continue;
        if (group.kinds?.includes(app.kind)) {
          score += 0.75;
          reasons.push(`"${word}" → ${app.kind} app`);
        }
        if (group.capability !== undefined && capabilities.includes(group.capability)) {
          score += 1;
          reasons.push(`"${word}" → ${group.capability} capability lives here`);
        }
      }
    }
    const relevance = Math.min(1, score / Math.max(1, Math.min(words.length, 3)));
    return {
      ...app,
      relevance: Math.round(relevance * 100) / 100,
      why: reasons.slice(0, 3).join("; ") || "no direct match",
    };
  });
}

export interface TaskContextInput {
  readonly blueprint: BlueprintV2 | null;
  readonly observation: ProjectObservation;
  readonly evidence: readonly Evidence[];
  readonly task: string | null;
  readonly root: string;
}

export function buildTaskContext(input: TaskContextInput): TaskContext {
  const { blueprint, observation, task } = input;
  const scored = scoreApps(blueprint, observation, task);
  const matched = scored.filter((app) => app.relevance > 0);
  const relevant = (
    matched.length > 0 ? matched : scored.map((app) => ({ ...app, relevance: 0.1 }))
  ).sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path));
  const relevantPaths = new Set(relevant.map((app) => app.path));
  const relevantIds = new Set(relevant.map((app) => app.id));

  const units = relevant.map((app) => ({
    id: app.id,
    path: app.path,
    kind: app.kind,
    framework: app.framework,
    entry: app.entry,
    scripts: Object.keys(
      observation.units.find((unit) => unit.path === app.path)?.scripts ?? {},
    ).sort(),
    relevance: app.relevance,
    why: app.why,
  }));

  const commands = [{ purpose: "install", command: "bun install", cwd: "." }];
  for (const unit of units) {
    for (const script of unit.scripts) {
      commands.push({ purpose: script, command: `bun run ${script}`, cwd: unit.path });
    }
  }

  const capabilities = (blueprint?.capabilities ?? [])
    .filter((entry) => relevantIds.has(entry.target))
    .map((entry) => ({ id: entry.id, recipe: entry.recipe, target: entry.target }));
  const capabilityIds = new Set(capabilities.map((entry) => entry.id));

  const environment = (blueprint?.environment ?? [])
    .filter((entry) => relevantPaths.has(entry.consumer))
    .map((entry) => ({
      name: entry.name,
      consumer: entry.consumer,
      scope: entry.scope,
      sensitivity: entry.sensitivity,
      required: entry.required,
      storage: entry.storage,
    }));

  const acceptance = (blueprint?.verification ?? [])
    .filter(
      (contract) =>
        (contract.unit !== null && relevantPaths.has(contract.unit)) ||
        (contract.capability !== null && capabilityIds.has(contract.capability)),
    )
    .map((contract) => ({
      id: contract.id,
      profile: contract.profile,
      description: contract.description,
      command: `groot verify --json --profile ${contract.profile}${contract.capability === null ? "" : ` --capability ${contract.capability}`}`,
    }));

  const latest = new Map<string, Evidence>();
  for (const record of input.evidence) {
    // A cancelled run's placeholder is not a result; the one before it still stands.
    if (record.reason === CANCELLED_REASON) continue;
    const relevantRecord =
      (record.scope.unit !== null && relevantPaths.has(record.scope.unit)) ||
      (record.scope.capability !== null && capabilityIds.has(record.scope.capability)) ||
      (record.scope.unit === null && record.scope.capability === null);
    if (relevantRecord && !latest.has(record.check)) latest.set(record.check, record);
  }
  const evidence = [...latest.values()].slice(0, 12).map((record) => ({
    id: record.id,
    check: record.check,
    status: record.status,
    at: record.finishedAt,
  }));

  const gaps: string[] = [];
  for (const record of latest.values()) {
    if (record.status === "fail" || record.status === "blocked") {
      gaps.push(
        `${record.check} is ${record.status}: ${record.reason ?? record.summary}${record.nextStep ? ` — next: ${record.nextStep}` : ""}`,
      );
    }
  }
  if (blueprint !== null) {
    for (const contract of missingRequiredEnv(input.root, blueprint.environment)) {
      if (relevantPaths.has(contract.consumer))
        gaps.push(`${contract.name} is not set in ${contract.storage}`);
    }
  } else {
    gaps.push(
      "project is not registered with groot (run `groot adopt --dry-run` to preview registration)",
    );
  }
  gaps.push(
    ...observation.unknowns.slice(0, 5),
    ...observation.contradictions.map((entry) => entry.explanation),
  );

  const words = new Set(tokens(task ?? ""));
  const decisions = (blueprint?.decisions ?? []).filter(
    (decision) =>
      decision.authority === "human" || tokens(decision.topic).some((word) => words.has(word)),
  );

  return {
    $schema: schemaUrl("context"),
    schemaVersion: 1,
    kind: "groot.context",
    task,
    project: {
      name: blueprint?.project.name ?? observation.name.value ?? "unknown",
      topology: blueprint?.project.topology ?? observation.topology.value,
      registered: blueprint !== null,
      revision: {
        vcs: observation.git.vcs,
        head: observation.git.head,
        branch: observation.git.branch,
        dirty: observation.git.dirty,
        worktreeFingerprint: observation.git.worktreeFingerprint,
      },
    },
    units,
    capabilities,
    decisions,
    conventions: [
      "Bun only: bun install, bun run <script>, bunx <tool> — never npm, npx, yarn, or pnpm.",
      `Shared packages use the ${blueprint?.conventions.packagesNamespace ?? "@repo"} namespace.`,
      "groot.json and groot.lock.json are machine-managed; change the project with groot plan/apply.",
      "Text between groot:begin/groot:end markers is generated; write notes outside it.",
    ],
    commands,
    environment,
    acceptance,
    evidence,
    gaps: [...new Set(gaps)],
    sources: [
      blueprint === null ? "discovery only (unregistered)" : "groot.json (desired state)",
      "groot inspect (observed state, static discovery)",
      ...(evidence.length > 0 ? [".groot/evidence (latest per check)"] : []),
    ],
  };
}
