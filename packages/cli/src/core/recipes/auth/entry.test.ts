import { describe, expect, test } from "bun:test";
import { GrootV2Error } from "../../errors.ts";
import { assertStillParses } from "./entry.ts";

const PATH = "src/index.ts";

/** An auth.routes region as the transform writes it. */
const routes = (indent = ""): string =>
  [
    `${indent}// groot:begin auth.routes`,
    `${indent}app.route("/api/auth", authRoutes);`,
    `${indent}app.route("/api/notes", notesRoutes);`,
    `${indent}// groot:end auth.routes`,
  ].join("\n");

function refusal(original: string, planned: string): GrootV2Error | null {
  try {
    assertStillParses(original, planned, PATH);
    return null;
  } catch (error) {
    if (error instanceof GrootV2Error) return error;
    throw error;
  }
}

describe("assertStillParses", () => {
  const original =
    "const app = new Hono({\n  getPath: (req) => {\n    const path = req.url\n    return path\n  },\n});\n\nexport default app;\n";

  test("a planned entry that no longer parses → conflict", () => {
    // Arrange
    const planned = original.replace("});\n", `});\n${routes()}\n  .use(logger());\n`);
    // Act
    const error = refusal(original, planned);
    // Assert
    expect(error?.id).toBe("GROOT_E_CONFLICT");
    expect(error?.details).toMatchObject({ path: PATH, reason: "unparseable result" });
  });

  test("a new region inside a function body parses, yet is refused: it isn't between top-level statements", () => {
    // Arrange
    const planned = original.replace("    return path\n", `${routes("    ")}\n    return path\n`);
    // Act
    const error = refusal(original, planned);
    // Assert
    expect(error?.id).toBe("GROOT_E_CONFLICT");
    expect(error?.message).toContain('"auth.routes"');
    expect(error?.details).toMatchObject({ path: PATH, reason: "region not at top level" });
  });

  test.each([
    ["a new region between top-level statements", original.replace("});\n", `});\n${routes()}\n`)],
    ["nothing planned (the entry as it was)", original],
  ])("%s → accepted", (_case, planned) => {
    expect(refusal(original, planned)).toBeNull();
  });

  test("a region the human moved into a function stays theirs: refreshed in place, not judged", () => {
    // Arrange
    const moved = original.replace("    return path\n", `${routes("    ")}\n    return path\n`);
    // Act / Assert
    expect(refusal(moved, `${moved}// a later edit\n`)).toBeNull();
  });

  test("an entry that didn't parse before can't be judged by parsing → left to the other checks", () => {
    // Arrange
    const broken = "const app = new Hono(\n";
    // Act / Assert
    expect(refusal(broken, `${broken}${routes()}\n`)).toBeNull();
  });
});
