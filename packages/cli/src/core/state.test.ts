/**
 * `.groot/` containment: a repository can commit `.groot`, `.groot/.gitignore`,
 * or a state subdirectory as a symlink; Groot must refuse rather than write
 * through it, and ids must never become traversals.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrootV2Error } from "./errors.ts";
import { acquireProjectLock } from "./fs/lock.ts";
import { ensureStateDir, statePaths } from "./state.ts";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "groot-state-")));
}

/** The GrootV2Error id `fn` throws (fails the test when it returns normally). */
function errorIdOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GrootV2Error) return error.id;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("state directory containment", () => {
  test("a symlinked .groot is refused and nothing is written outside the project", () => {
    // Arrange
    const base = scratch();
    const root = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".groot"));

    // Act
    const ids = [
      errorIdOf(() => ensureStateDir(root)),
      errorIdOf(() => acquireProjectLock(root, { command: "apply", operationId: null })),
      errorIdOf(() => statePaths.evidence(root, "ev_0000000000000000000001")),
    ];

    // Assert
    expect(ids).toEqual([
      "GROOT_E_PATH_OUTSIDE_PROJECT",
      "GROOT_E_PATH_OUTSIDE_PROJECT",
      "GROOT_E_PATH_OUTSIDE_PROJECT",
    ]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a symlinked .groot/.gitignore is refused, its target never created", () => {
    // Arrange
    const base = scratch();
    const root = join(base, "project");
    mkdirSync(join(root, ".groot"), { recursive: true });
    const target = join(base, "global-ignore");
    symlinkSync(target, join(root, ".groot/.gitignore"));

    // Act
    const id = errorIdOf(() => ensureStateDir(root));

    // Assert
    expect(id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    expect(existsSync(target)).toBe(false);
  });

  test("an existing .groot/.gitignore file is left alone", () => {
    // Arrange
    const root = scratch();
    mkdirSync(join(root, ".groot"));
    writeFileSync(join(root, ".groot/.gitignore"), "# mine\n*\n");

    // Act
    ensureStateDir(root);

    // Assert
    expect(readFileSync(join(root, ".groot/.gitignore"), "utf8")).toBe("# mine\n*\n");
  });

  test("a symlinked state subdirectory is refused", () => {
    // Arrange
    const base = scratch();
    const root = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(join(root, ".groot"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".groot/evidence"));

    // Act
    const id = errorIdOf(() => statePaths.evidence(root, "ev_0000000000000000000001"));

    // Assert
    expect(id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("state ids", () => {
  test("ids are validated before they become path segments", () => {
    // Arrange
    const root = scratch();

    // Act
    const ids = [
      errorIdOf(() => statePaths.plan(root, "../x")),
      errorIdOf(() => statePaths.operation(root, "../../etc")),
      errorIdOf(() => statePaths.evidence(root, "../../outside")),
      errorIdOf(() => statePaths.task(root, "task_ok/../../x")),
    ];

    // Assert
    expect(ids).toEqual(["GROOT_E_USAGE", "GROOT_E_USAGE", "GROOT_E_USAGE", "GROOT_E_USAGE"]);
    expect(statePaths.plan(root, "plan_0000000000000000000001")).toBe(
      join(root, ".groot/plans/plan_0000000000000000000001.json"),
    );
  });
});
