/**
 * PlanBuilder previews: an edit carries an exact `after` only when the
 * content it applies to is known at planning time. Edits that follow a step
 * which changes the file without a preview (deps.add, a deferred or
 * secret-bearing edit) are deferred to the executor, and secret-bearing
 * edits (env edits, non-example dotenv files) never carry content at all.
 */
import { describe, expect, test } from "bun:test";
import type { FileEditAction, OperationPlan } from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { addDeps, buildPlan, scratchProject } from "../executor/test-support.ts";
import { sha256Of } from "../fs/hash.ts";
import type { PlanBuilder } from "./builder.ts";

const PACKAGE_JSON = '{\n  "name": "app",\n  "dependencies": {\n    "hono": "4.9.0"\n  }\n}\n';
const DB_PASSWORD = "Pg-Pr0d-Passw0rd";
const STRIPE_KEY = "rk_live_51HsecretStripeKey";
const ENV_LOCAL = `DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/app\nSTRIPE_SECRET_KEY=${STRIPE_KEY}\n`;

function edits(plan: OperationPlan): FileEditAction[] {
  return plan.actions.filter((action): action is FileEditAction => action.type === "file.edit");
}

async function appendLine(
  builder: PlanBuilder,
  path: string,
  line: string,
  deferred = false,
): Promise<string | null> {
  return builder.editFile({
    path,
    edit: { kind: "lines", lines: [line], header: null },
    description: `append ${line} to ${path}`,
    owns: [],
    createIfMissing: false,
    deferred,
  });
}

async function addEnvEntry(
  builder: PlanBuilder,
  path: string,
  name: string,
): Promise<string | null> {
  return builder.editFile({
    path,
    edit: { kind: "env", entries: [{ name, value: "http://localhost:3000", comment: null }] },
    description: `add ${name} to ${path}`,
    owns: [],
    createIfMissing: true,
  });
}

describe("PlanBuilder: exact previews only from known content", () => {
  test("an edit after deps.add on the same package.json is deferred, not previewed from stale content", async () => {
    // Arrange
    const root = scratchProject({ "package.json": PACKAGE_JSON });

    // Act
    const plan = await buildPlan(root, async (b) => {
      await addDeps(b, [{ package: "drizzle-orm", to: "0.44.0", dev: false }]);
      await b.editFile({
        path: "package.json",
        edit: { kind: "json", ops: [{ op: "set", pointer: "/scripts/db:migrate", value: "x" }] },
        description: "add db:migrate",
        owns: [],
        createIfMissing: false,
      });
    });

    // Assert
    const [edit] = edits(plan);
    expect(edit?.expect).toEqual({ state: "produced", byStep: "s01" });
    expect(edit?.after).toBeNull();
  });

  test("an edit after a deferred edit of the same file is deferred too", async () => {
    // Arrange
    const root = scratchProject();

    // Act
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "notes.txt", content: "one\n", description: "write notes" });
      await appendLine(b, "notes.txt", "two", true);
      await appendLine(b, "notes.txt", "three");
    });

    // Assert
    expect(edits(plan).map((edit) => edit.after)).toEqual([null, null]);
  });

  test("an edit after a write keeps its exact preview", async () => {
    // Arrange
    const root = scratchProject();

    // Act
    const plan = await buildPlan(root, async (b) => {
      await b.writeFile({ path: "notes.txt", content: "one\n", description: "write notes" });
      await appendLine(b, "notes.txt", "two");
      await appendLine(b, "notes.txt", "three");
    });

    // Assert
    expect(edits(plan).map((edit) => edit.after?.content)).toEqual([
      "one\n\ntwo\n",
      "one\n\ntwo\n\nthree\n",
    ]);
  });

  test("an edit of a file on disk keeps its exact preview and pins the file's hash", async () => {
    // Arrange
    const root = scratchProject({ "README.md": "# Demo\n" });

    // Act
    const plan = await buildPlan(root, async (b) => {
      await appendLine(b, "README.md", "Managed by groot.");
    });

    // Assert
    const [edit] = edits(plan);
    expect(edit?.expect).toEqual({ state: "sha256", sha256: sha256Of("# Demo\n") });
    expect(edit?.after?.content).toBe("# Demo\n\nManaged by groot.\n");
  });
});

describe("PlanBuilder: secret-bearing edits carry no content", () => {
  test("an env edit of a dotenv file pins its hash but the plan holds none of its values", async () => {
    // Arrange
    const root = scratchProject({ "apps/web/.env.local": ENV_LOCAL });

    // Act
    const plan = await buildPlan(root, async (b) => {
      await addEnvEntry(b, "apps/web/.env.local", "BETTER_AUTH_URL");
    });

    // Assert
    const [edit] = edits(plan);
    expect(edit?.after).toBeNull();
    expect(edit?.expect).toEqual({ state: "sha256", sha256: sha256Of(ENV_LOCAL) });
    expect(edit?.edit).toMatchObject({ kind: "env", entries: [{ name: "BETTER_AUTH_URL" }] });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(DB_PASSWORD);
    expect(serialized).not.toContain(STRIPE_KEY);
  });

  test("an env edit that changes nothing is skipped, and a later edit of the file is deferred", async () => {
    // Arrange
    const root = scratchProject({ ".env.local": ENV_LOCAL });

    // Act
    const plan = await buildPlan(root, async (b) => {
      expect(await addEnvEntry(b, ".env.local", "DATABASE_URL")).toBeNull();
      await addEnvEntry(b, ".env.local", "BETTER_AUTH_URL");
      await appendLine(b, ".env.local", "# managed by groot");
    });

    // Assert
    expect(edits(plan).map((edit) => [edit.expect.state, edit.after])).toEqual([
      ["sha256", null],
      ["produced", null],
    ]);
    expect(JSON.stringify(plan)).not.toContain(DB_PASSWORD);
  });

  test("any edit of a non-example dotenv file is content-less; example files keep exact previews", async () => {
    // Arrange
    const root = scratchProject({ ".env": ENV_LOCAL, ".env.example": "DATABASE_URL=\n" });

    // Act
    const plan = await buildPlan(root, async (b) => {
      await appendLine(b, ".env", "# local only");
      await appendLine(b, ".env.example", "BETTER_AUTH_URL=");
    });

    // Assert
    expect(edits(plan).map((edit) => edit.after?.content ?? null)).toEqual([
      null,
      "DATABASE_URL=\n\nBETTER_AUTH_URL=\n",
    ]);
  });

  test("transform conflicts are still detected for content-less edits", async () => {
    // Arrange
    const tampered = `${ENV_LOCAL}# groot:begin auth sha256:${"0".repeat(64)}\nAUTH=edited\n# groot:end auth\n`;
    const root = scratchProject({ ".env.local": tampered });

    // Act
    let error: unknown;
    try {
      await buildPlan(root, async (b) => {
        await b.editFile({
          path: ".env.local",
          edit: {
            kind: "managed-region",
            regionId: "auth",
            content: "AUTH=1",
            commentStyle: "hash",
            placement: "end",
          },
          description: "refresh the auth block",
          owns: ["auth"],
          createIfMissing: false,
        });
      });
    } catch (caught) {
      error = caught;
    }

    // Assert
    expect(error).toBeInstanceOf(GrootV2Error);
    expect((error as GrootV2Error).id).toBe("GROOT_E_CONFLICT");
    expect((error as GrootV2Error).message).not.toContain(DB_PASSWORD);
  });
});
