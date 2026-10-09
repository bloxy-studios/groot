/**
 * Task building blocks without git or runners: ownership globs and overlap,
 * shell-free acceptance argv, limits and acceptance construction, prompts,
 * secret findings (locations only), diff parsing, and the acceptance-first
 * verdict.
 */
import { describe, expect, test } from "bun:test";
import { schemaUrl } from "../contracts/common.ts";
import type { Task } from "../contracts/task.ts";
import type { RunnerResult } from "../runners/types.ts";
import { formatArgv, splitCommand } from "./argv.ts";
import { buildAcceptance, buildLimits } from "./create.ts";
import {
  globToRegExp,
  literalPrefix,
  matchesOwnership,
  ownershipOverlap,
  patternsOverlap,
  validateOwnership,
} from "./ownership.ts";
import { allowedCommands, continuePrompt, startPrompt, taskRules } from "./prompt.ts";
import { parseNameStatus, parseNumstat } from "./review.ts";
import { judge } from "./run.ts";
import { findSecrets, parseAddedLines, secretKind } from "./secrets.ts";

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    $schema: schemaUrl("task"),
    schemaVersion: 1,
    kind: "groot.task",
    id: "task_0000000001abcdef",
    title: "Fix add()",
    objective: "Make the failing test pass without changing the test.",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    runner: "claude-code",
    model: "opus",
    dependsOn: [],
    ownership: ["src/**"],
    acceptance: buildAcceptance({ objective: "x", accept: ["bun test"] }),
    limits: buildLimits("claude-code", {}),
    status: "pending",
    statusReason: null,
    base: { branch: "main", commit: "a".repeat(40) },
    worktree: null,
    attempts: [],
    evidence: [],
    review: null,
    integration: null,
    ...overrides,
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    status: "succeeded",
    sessionId: "s",
    exitCode: 0,
    usage: {
      kind: "unavailable",
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      turns: null,
      durationMs: 0,
      source: "x",
    },
    finalMessage: null,
    error: null,
    simulated: true,
    notes: [],
    ...overrides,
  };
}

const record = (status: "pass" | "fail" | "skipped" | "blocked") => ({
  criterion: "accept-1",
  status,
  evidence: ["ev_0000000001abcdef"],
  summary: `bun test ${status}`,
  tail: status === "fail" ? "expected 3, got 4" : "",
});

describe("ownership globs", () => {
  test("matching: ** spans directories, * stays in a segment, bare names cover directories", () => {
    expect(matchesOwnership("src/math.ts", ["src/**"])).toBe(true);
    expect(matchesOwnership("src/deep/a.ts", ["src/*.ts"])).toBe(false);
    expect(matchesOwnership("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(matchesOwnership("README.md", ["src/**"])).toBe(false);
    expect(matchesOwnership("anything/at/all", ["**"])).toBe(true);
    expect(matchesOwnership("a/b/c.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(matchesOwnership("c.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(matchesOwnership("apps/web/page.tsx", ["apps/{web,api}/**"])).toBe(true);
    expect(matchesOwnership("docs/guide.md", ["docs"])).toBe(true);
    expect(globToRegExp("file[0-9].txt").test("file7.txt")).toBe(true);
  });

  test("overlap is conservative: identical or nested prefixes overlap, ** overlaps everything", () => {
    expect(patternsOverlap("src/**", "src/**")).toBe(true);
    expect(patternsOverlap("src/**", "src/api/**")).toBe(true);
    expect(patternsOverlap("src/a.ts", "src/**")).toBe(true);
    expect(patternsOverlap("**", "docs/**")).toBe(true);
    expect(patternsOverlap("src/**", "docs/**")).toBe(false);
    expect(patternsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(literalPrefix("apps/web/**/*.tsx")).toBe("apps/web");
    expect(ownershipOverlap(["docs/**", "src/**"], ["tests/**", "src/util/**"])).toEqual([
      "src/**",
      "src/util/**",
    ]);
    expect(ownershipOverlap(["docs/**"], ["src/**"])).toBeNull();
  });

  test("patterns must stay project-relative", () => {
    expect(validateOwnership("./src/**")).toBe("src/**");
    for (const bad of ["/etc/**", "../x/**", "C:/x", "src\\x", ""]) {
      expect(() => validateOwnership(bad)).toThrow(/Invalid ownership/);
    }
  });
});

describe("acceptance commands without a shell", () => {
  test("quotes and escapes split like a shell would", () => {
    expect(splitCommand("bun test")).toEqual(["bun", "test"]);
    expect(splitCommand(`bun test --grep "adds two numbers" 'single quoted'`)).toEqual([
      "bun",
      "test",
      "--grep",
      "adds two numbers",
      "single quoted",
    ]);
    expect(splitCommand("printf a\\ b")).toEqual(["printf", "a b"]);
    expect(formatArgv(["bun", "test", "--grep", "two words"])).toBe("bun test --grep 'two words'");
  });

  test("anything that needs a shell is refused instead of passed literally", () => {
    for (const command of [
      "bun test && bun run lint",
      "bun test | tee log",
      "echo $HOME",
      "ls > out",
      "echo `id`",
      'echo "$(id)"',
      "cat ~/x",
      "",
      "  ",
      "'unterminated",
    ]) {
      expect(() => splitCommand(command)).toThrow(/Acceptance command/);
    }
  });

  test("criteria and limits are built from input with defaults", () => {
    const criteria = buildAcceptance({
      objective: "x",
      accept: ["bun test"],
      acceptVerify: ["build", "build"],
    });
    expect(criteria.map((entry) => [entry.id, entry.kind, entry.argv, entry.profile])).toEqual([
      ["accept-1", "command", ["bun", "test"], null],
      ["verify-build", "verify", null, "build"],
    ]);
    expect(buildLimits("claude-code", {})).toEqual({
      wallTimeSec: 900,
      maxTurns: 25,
      maxBudgetUsd: 2,
      maxAttempts: 2,
    });
    expect(buildLimits("codex", {}).maxBudgetUsd).toBeNull();
    expect(() => buildLimits("claude-code", { maxAttempts: 9 })).toThrow(/limits/);
    expect(() => buildAcceptance({ objective: "x", acceptVerify: ["nope" as never] })).toThrow(
      /profile/,
    );
  });

  test("wall time and acceptance timeouts are capped at 24 hours (timers overflow beyond ~24.8 days)", () => {
    // Act / Assert
    expect(buildLimits("claude-code", { wallTimeSec: 86_400 }).wallTimeSec).toBe(86_400);
    expect(() => buildLimits("claude-code", { wallTimeSec: 86_401 })).toThrow(/wallTimeSec/);
    expect(() => buildLimits("claude-code", { wallTimeSec: 2_147_484 })).toThrow(/86400/);
    expect(
      buildAcceptance({ objective: "x", accept: ["bun test"], acceptTimeoutSec: 86_400 })[0],
    ).toMatchObject({ timeoutMs: 86_400_000 });
    expect(() =>
      buildAcceptance({ objective: "x", accept: ["bun test"], acceptTimeoutSec: 86_401 }),
    ).toThrow(/86400/);
  });
});

describe("prompts", () => {
  test("the first prompt carries objective, ownership boundary, acceptance, rules, and project context", () => {
    // Act
    const prompt = startPrompt(taskFixture(), "Project: demo (single)");

    // Assert
    expect(prompt).toContain("Make the failing test pass without changing the test.");
    expect(prompt).toContain("Only change files matching: `src/**`");
    expect(prompt).toContain("`bun test`");
    expect(prompt).toContain("Do not commit, push");
    expect(prompt).toContain("Before you finish, run `bun test`");
    expect(prompt).toContain("## Project context (from groot)\n\nProject: demo (single)");
  });

  test("retry prompts feed back the failing check output; review notes are delivered verbatim", () => {
    const task = taskFixture();
    expect(continuePrompt(task, { kind: "retry", failures: [record("fail")] })).toContain(
      "expected 3, got 4",
    );
    expect(continuePrompt(task, { kind: "changes-requested", notes: "keep the API" })).toContain(
      "keep the API",
    );
    expect(continuePrompt(task, { kind: "resume", acceptance: null })).toContain("not run yet");
    expect(taskRules(taskFixture({ ownership: ["**"] }))).toContain("You may change any file");
    expect(allowedCommands(task)).toEqual(["bun test", "git status", "git diff"]);
  });
});

describe("verdict: acceptance evidence first", () => {
  test("all acceptance passing → awaiting review, even when the runner hit a limit (noted)", () => {
    expect(judge(runnerResult(), [record("pass")])).toEqual({
      status: "awaiting-review",
      reason: null,
    });
    const limited = judge(runnerResult({ status: "budget-exceeded" }), [record("pass")]);
    expect(limited.status).toBe("awaiting-review");
    expect(limited.reason).toContain("budget-exceeded");
  });

  test("a runner claiming success never overrides failing checks; retry only after retryable outcomes", () => {
    expect(judge(runnerResult(), [record("fail")]).status).toBe("retry");
    expect(judge(runnerResult({ status: "failed" }), [record("fail")]).status).toBe("retry");
    expect(judge(runnerResult({ status: "timed-out" }), [record("fail")]).status).toBe("failed");
    expect(judge(runnerResult(), [record("blocked")]).status).toBe("blocked");
    expect(judge(runnerResult(), [record("skipped")]).status).toBe("blocked");
  });

  test("without criteria only the runner's own success can reach review", () => {
    expect(judge(runnerResult(), []).status).toBe("awaiting-review");
    expect(judge(runnerResult({ status: "failed" }), []).status).toBe("retry");
  });
});

describe("secret findings and diff parsing", () => {
  test("added secret-looking lines are reported by location and kind, never by value", () => {
    // Arrange
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,0 +2,3 @@",
      '+const API_KEY = "abcd1234efgh5678";',
      "+const token = getToken();",
      "+const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
      "diff --git a/.env.local b/.env.local",
      "--- /dev/null",
      "+++ b/.env.local",
      "@@ -0,0 +1,2 @@",
      "+DATABASE_PASSWORD=hunter22hunter22",
      "+PUBLIC_URL=http://localhost",
    ].join("\n");

    // Act
    const findings = findSecrets(parseAddedLines(diff), [".env.local", "src/new.ts"]);

    // Assert
    expect(findings).toEqual([
      ".env.local — added a file of a kind that usually holds secrets",
      "src/config.ts:2 — literal value assigned to API_KEY",
      "src/config.ts:4 — GitHub token",
      ".env.local:1 — value for DATABASE_PASSWORD",
    ]);
    expect(findings.join("\n")).not.toContain("abcd1234efgh5678");
    expect(findings.join("\n")).not.toContain("hunter22");
    expect(secretKind("src/a.ts", 'const password = "changeme";')).toBeNull();
    expect(secretKind(".env.example", "API_TOKEN=your-token-here")).toBeNull();
    // Real-looking values are reported even in example files (a classic leak).
    expect(secretKind(".env.example", "API_TOKEN=abcdefgh12345678")).toBe("value for API_TOKEN");
  });

  test("name-status and numstat -z parsing handle renames and binaries", () => {
    const names = parseNameStatus(
      ["M", "src/a.ts", "A", "notes.md", "R087", "old.ts", "src/new.ts", "D", "gone.ts", ""].join(
        "\0",
      ),
    );
    expect(names).toEqual([
      { status: "modified", from: null, path: "src/a.ts" },
      { status: "added", from: null, path: "notes.md" },
      { status: "renamed", from: "old.ts", path: "src/new.ts" },
      { status: "deleted", from: null, path: "gone.ts" },
    ]);
    const counts = parseNumstat(
      ["3\t1\tsrc/a.ts", "-\t-\timg.png", "2\t2\t", "old.ts", "src/new.ts", ""].join("\0"),
    );
    expect(counts.get("src/a.ts")).toEqual([3, 1]);
    expect(counts.get("img.png")).toEqual([0, 0]);
    expect(counts.get("src/new.ts")).toEqual([2, 2]);
  });
});
