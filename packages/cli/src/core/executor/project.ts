/**
 * Root normalization. Plans record the absolute root they were computed for;
 * apply refuses any other root. Both sides are compared after realpath, so
 * symlinked spellings of the same directory (macOS /tmp → /private/tmp,
 * /var → /private/var) are the same project, and the executor works on the
 * canonical path from then on.
 */
import { realpathSync, statSync } from "node:fs";
import { GrootV2Error } from "../errors.ts";

function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The canonical project root; GROOT_E_USAGE when it doesn't exist or isn't a directory. */
export function realRoot(root: string): string {
  const real = realDir(root);
  if (real === null) {
    throw new GrootV2Error(
      "GROOT_E_USAGE",
      `Project root ${root} does not exist or is not a directory.`,
      {
        details: { root },
      },
    );
  }
  return real;
}

/** Canonical root, refusing a plan computed for a different project root. */
export function canonicalRoot(root: string, planRoot: string): string {
  const real = realRoot(root);
  if (realDir(planRoot) !== real) {
    throw new GrootV2Error("GROOT_E_USAGE", `This plan was made for ${planRoot}, not ${root}.`, {
      hint: "Apply it from the project it was planned for, or re-create the plan here.",
      details: { planRoot, root },
    });
  }
  return real;
}
