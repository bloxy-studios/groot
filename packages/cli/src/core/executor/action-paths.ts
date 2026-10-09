/**
 * What each action type says about project paths: every path a step names
 * (refused when reserved, reserved.ts), the path it produces (what a later
 * step's `produced` expectation may name), and the expectation it checks
 * right before it runs. Plan integrity (plans.ts), freshness, and the step
 * runner share these so they can never disagree about an action's paths.
 */
import type { PathExpectation, PlannedAction } from "../contracts/plan.ts";

export function packageJsonPath(unit: string): string {
  return unit === "." ? "package.json" : `${unit}/package.json`;
}

export interface NamedPath {
  /** Field below the action that names it ("path", "touches.0", …), for issue paths. */
  readonly field: string;
  readonly path: string;
}

/** Every project path an action names: targets, touched files, working directories. */
export function namedPaths(action: PlannedAction): NamedPath[] {
  const touches = (paths: readonly string[]): NamedPath[] =>
    paths.map((path, index) => ({ field: `touches.${index}`, path }));
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.delete":
    case "env.secret":
      return [{ field: "path", path: action.path }];
    case "file.move":
      return [
        { field: "from", path: action.from },
        { field: "to", path: action.to },
      ];
    case "deps.add":
      return [{ field: "unit", path: packageJsonPath(action.unit) }];
    case "command.run":
      return [{ field: "cwd", path: action.cwd }, ...touches(action.touches)];
    case "generator.run":
      return [
        { field: "cwd", path: action.cwd },
        { field: "produces", path: action.produces },
      ];
    case "internal":
      return touches(action.touches);
    case "external":
      return [];
  }
}

/**
 * The path a step produces: a later step may expect it as `produced` by this
 * step. Mirrors what the PlanBuilder records (planner/builder.ts).
 */
export function producedPath(action: PlannedAction): string | null {
  switch (action.type) {
    case "file.write":
    case "file.edit":
      return action.path;
    case "file.move":
      return action.to;
    case "deps.add":
      return packageJsonPath(action.unit);
    case "generator.run":
      return action.produces;
    default:
      return null;
  }
}

export interface OwnExpectation {
  readonly path: string;
  readonly expect: PathExpectation;
}

/** The expectation a step re-checks right before its effect, and the path it applies to. */
export function ownExpectation(action: PlannedAction): OwnExpectation | null {
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.delete":
      return { path: action.path, expect: action.expect };
    case "file.move":
      return { path: action.from, expect: action.expect };
    case "deps.add":
      return { path: packageJsonPath(action.unit), expect: action.expect };
    default:
      return null;
  }
}

/** True when `path` is `dir` or lies inside it ("." contains everything). */
export function isWithin(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}
