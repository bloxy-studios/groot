/**
 * Foundation contracts: project-boundary enforcement (incl. symlinks), atomic
 * writes, the writer lock (exclusive, stale takeover, live refusal),
 * redaction, git porcelain parsing, ids, and the contract registry.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACTS, contractJsonSchema } from "./contracts/index.ts";
import { GrootV2Error } from "./errors.ts";
import { appendLineDurable, writeFileAtomic } from "./fs/atomic.ts";
import { hashTree, sha256Of } from "./fs/hash.ts";
import { acquireProjectLock, isProcessAlive } from "./fs/lock.ts";
import { joinRel, resolveInProject } from "./fs/paths.ts";
import { parsePorcelainZ } from "./git.ts";
import { newId } from "./ids.ts";
import { canonicalJson, parseJsonc } from "./json.ts";
import { redact } from "./redact.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "groot-core-"));
}

/** The error `fn` throws (fails the test when it returns normally). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("project boundary", () => {
  test("accepts nested relative paths, refuses escapes and absolutes", () => {
    const root = scratch();
    expect(resolveInProject(root, "apps/api/src/index.ts")).toBe(
      join(root, "apps/api/src/index.ts"),
    );
    for (const bad of ["../outside", "apps/../../x", "/etc/passwd", "C:/x", "a\\b", ""]) {
      expect(() => resolveInProject(root, bad)).toThrow(GrootV2Error);
    }
  });

  test.skipIf(process.platform === "win32")(
    "resolves an existing file it may not read (chmod 000) without a raw errno error",
    () => {
      const root = scratch();
      writeFileSync(join(root, "locked.txt"), "x");
      chmodSync(join(root, "locked.txt"), 0o000);
      try {
        expect(resolveInProject(root, "locked.txt")).toBe(join(root, "locked.txt"));
      } finally {
        chmodSync(join(root, "locked.txt"), 0o644);
      }
    },
  );

  test("refuses a path whose symlinked parent points outside the project", () => {
    const root = scratch();
    const outside = scratch();
    symlinkSync(outside, join(root, "linked"));
    expect(() => resolveInProject(root, "linked/new-file.ts")).toThrow(/symlink/);
    mkdirSync(join(root, "real"));
    expect(resolveInProject(root, "real/new-file.ts")).toBe(join(root, "real/new-file.ts"));
  });

  test("refuses dangling symlinks that point outside the project", () => {
    // Arrange: links whose targets do not exist yet, so realpath cannot follow them.
    const root = scratch();
    const outside = scratch();
    symlinkSync(join(outside, "new-dir"), join(root, "linkdir"));
    symlinkSync(join(outside, "target.txt"), join(root, "linkfile"));
    symlinkSync("../../escape.txt", join(root, "relative-link"));

    // Act + Assert
    for (const path of ["linkdir/file.txt", "linkdir", "linkfile", "relative-link"]) {
      expect(() => resolveInProject(root, path)).toThrow(/symlink/);
    }
  });

  test("accepts dangling symlinks whose targets stay inside the project", () => {
    // Arrange
    const root = scratch();
    mkdirSync(join(root, "real"));
    symlinkSync("real/not-yet.txt", join(root, "inner-link"));
    symlinkSync(join(root, "real", "later"), join(root, "inner-dir"));

    // Act
    const file = resolveInProject(root, "inner-link");
    const nested = resolveInProject(root, "inner-dir/x/y.ts");

    // Assert
    expect(file).toBe(join(root, "inner-link"));
    expect(nested).toBe(join(root, "inner-dir/x/y.ts"));
  });

  test("refuses a dangling link whose `..` steps out through another symlink", () => {
    // Arrange: `..` after a symlinked directory leaves from the link's target,
    // not from the project — as the kernel resolves it.
    const root = scratch();
    const outside = scratch();
    mkdirSync(join(outside, "a/b"), { recursive: true });
    symlinkSync(join(outside, "a/b"), join(root, "deep"));
    symlinkSync("deep/../escaped.txt", join(root, "sneaky"));
    symlinkSync("deep/../newdir", join(root, "sneakydir"));
    symlinkSync("not-yet/../deep/../escaped.txt", join(root, "tricky"));

    // Act + Assert
    for (const path of ["sneaky", "sneakydir/file.txt", "tricky"]) {
      expect(() => resolveInProject(root, path)).toThrow(/symlink/);
    }
  });

  test("accepts a dangling link whose `..` steps stay inside the project", () => {
    // Arrange
    const root = scratch();
    mkdirSync(join(root, "real/sub"), { recursive: true });
    symlinkSync(join(root, "real/sub"), join(root, "inner"));
    symlinkSync("inner/../later.txt", join(root, "ok"));

    // Act
    const resolved = resolveInProject(root, "ok");

    // Assert
    expect(resolved).toBe(join(root, "ok"));
  });

  test("refuses a symlink loop instead of looping", () => {
    // Arrange
    const root = scratch();
    symlinkSync("b", join(root, "a"));
    symlinkSync("a", join(root, "b"));

    // Act + Assert
    expect(() => resolveInProject(root, "a/file.txt")).toThrow(GrootV2Error);
  });

  test("a web of dangling links with `..` resolves in bounded time", () => {
    // Arrange: each link's text passes through the others several times.
    const root = scratch();
    const names = ["l0", "l1", "l2", "l3"];
    for (const [index, name] of names.entries()) {
      const next = names[(index + 1) % names.length];
      symlinkSync(`${next}/../${next}/../${next}/../${next}/x`, join(root, name));
    }

    // Act
    const started = performance.now();
    const error = thrownBy(() => resolveInProject(root, "l0/file.txt"));

    // Assert
    expect((error as GrootV2Error).id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("joinRel treats '.' as the root", () => {
    expect(joinRel(".", "src/index.ts")).toBe("src/index.ts");
    expect(joinRel("apps/api", "./src", "auth.ts")).toBe("apps/api/src/auth.ts");
    expect(joinRel(".", ".")).toBe(".");
  });
});

describe("durable writes", () => {
  test("writeFileAtomic replaces content and leaves no temp files", () => {
    const root = scratch();
    const target = join(root, "deep/dir/file.json");
    writeFileAtomic(target, "one");
    writeFileAtomic(target, "two");
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(require("node:fs").readdirSync(join(root, "deep/dir"))).toEqual(["file.json"]);
  });

  test("appendLineDurable appends whole lines and rejects embedded newlines", () => {
    const file = join(scratch(), "journal.jsonl");
    appendLineDurable(file, '{"seq":0}');
    appendLineDurable(file, '{"seq":1}');
    expect(readFileSync(file, "utf8")).toBe('{"seq":0}\n{"seq":1}\n');
    expect(() => appendLineDurable(file, "a\nb")).toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "appendLineDurable never appends through a symlink",
    () => {
      // Arrange
      const root = scratch();
      const escaped = join(scratch(), "escaped.txt");
      symlinkSync(escaped, join(root, "journal.jsonl"));

      // Act
      const error = thrownBy(() => appendLineDurable(join(root, "journal.jsonl"), "line"));

      // Assert
      expect((error as GrootV2Error).id).toBe("GROOT_E_PATH_OUTSIDE_PROJECT");
      expect(existsSync(escaped)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "writeFileAtomic keeps the mode of the file it replaces unless one is given",
    () => {
      // Arrange
      const root = scratch();
      const secret = join(root, ".env.local");
      const script = join(root, "run.sh");
      const loose = join(root, "loose.env");
      writeFileSync(secret, "A=1\n");
      chmodSync(secret, 0o600);
      writeFileSync(script, "#!/bin/sh\n");
      chmodSync(script, 0o755);
      writeFileSync(loose, "B=1\n");
      chmodSync(loose, 0o644);

      // Act
      writeFileAtomic(secret, "A=2\n");
      writeFileAtomic(script, "#!/bin/sh\necho hi\n");
      writeFileAtomic(loose, "B=2\n", 0o600);
      writeFileAtomic(join(root, "new.txt"), "fresh", 0o600);

      // Assert
      expect(statSync(secret).mode & 0o777).toBe(0o600);
      expect(statSync(script).mode & 0o777).toBe(0o755);
      expect(statSync(loose).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "new.txt")).mode & 0o777).toBe(0o600);
      expect(readFileSync(secret, "utf8")).toBe("A=2\n");
    },
  );

  test("hashTree is order-independent and ignores node_modules", async () => {
    const root = scratch();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "a");
    writeFileSync(join(root, "b.ts"), "b");
    const before = await hashTree(root);
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules/x.js"), "x");
    expect(await hashTree(root)).toBe(before);
    writeFileSync(join(root, "b.ts"), "changed");
    expect(await hashTree(root)).not.toBe(before);
  });
});

describe("writer lock", () => {
  test("is exclusive while held and reusable after release", () => {
    const root = scratch();
    const lock = acquireProjectLock(root, { command: "apply", operationId: null });
    expect(() => acquireProjectLock(root, { command: "apply", operationId: null })).toThrow(
      /Another groot process/,
    );
    lock.release();
    acquireProjectLock(root, { command: "apply", operationId: null }).release();
  });

  test("takes over a lock left by a dead process on this host", async () => {
    const root = scratch();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    expect(isProcessAlive(dead.pid)).toBe(false);
    const first = acquireProjectLock(root, { command: "apply", operationId: "op_x" });
    // Simulate a crashed holder: rewrite the lock as owned by the dead pid.
    const lockPath = join(root, ".groot/lock.json");
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify({ ...holder, pid: dead.pid }));
    const second = acquireProjectLock(root, { command: "resume", operationId: "op_x" });
    expect(second.tookOverFrom?.pid).toBe(dead.pid);
    second.release();
    first.release(); // no-op: not the holder anymore
  });

  test("the state dir ignores itself", () => {
    const root = scratch();
    acquireProjectLock(root, { command: "x", operationId: null }).release();
    expect(readFileSync(join(root, ".groot/.gitignore"), "utf8")).toContain("*");
  });

  test("a fresh unreadable lock counts as held and is left in place", () => {
    // Arrange: the state between another writer's create and its holder write.
    const root = scratch();
    mkdirSync(join(root, ".groot"));
    const lockPath = join(root, ".groot/lock.json");
    writeFileSync(lockPath, "");

    // Act
    const error = thrownBy(() => acquireProjectLock(root, { command: "apply", operationId: null }));

    // Assert
    expect(error).toBeInstanceOf(GrootV2Error);
    expect((error as GrootV2Error).id).toBe("GROOT_E_LOCKED");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  test("an unreadable lock older than the grace period is recovered", () => {
    // Arrange: a writer crashed between its create and its holder write long ago.
    const root = scratch();
    mkdirSync(join(root, ".groot"));
    const lockPath = join(root, ".groot/lock.json");
    writeFileSync(lockPath, "");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    // Act
    const lock = acquireProjectLock(root, { command: "apply", operationId: null });

    // Assert
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("the lock file never exists without its holder record", () => {
    // Arrange
    const root = scratch();

    // Act
    const lock = acquireProjectLock(root, { command: "apply", operationId: "op_x" });

    // Assert: created complete, and no temp files are left beside it.
    const lockPath = join(root, ".groot/lock.json");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operationId: "op_x" });
    expect(readdirSync(join(root, ".groot")).sort()).toEqual([".gitignore", "lock.json"]);
    lock.release();
  });
});

describe("redaction", () => {
  test("masks known values, token shapes, sensitive assignments, and cookies", () => {
    const secret = "s3cr3t-value-xyz";
    const text = [
      `generated ${secret}`,
      "BETTER_AUTH_SECRET=abcdef123456",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      "set-cookie: better-auth.session_token=abc.def; Path=/",
      "DATABASE_URL=./data/app.db",
    ].join("\n");
    const out = redact(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain("BETTER_AUTH_SECRET=[REDACTED]");
    expect(out).not.toContain("ghp_");
    expect(out).toContain("better-auth.session_token=[REDACTED]");
    expect(out).toContain("DATABASE_URL=./data/app.db");
  });
});

describe("git porcelain parsing", () => {
  test("splits staged, unstaged, untracked; skips rename sources", () => {
    const out = [
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "?? new.ts",
      "R  to.ts",
      "from.ts",
      "",
    ].join("\0");
    expect(parsePorcelainZ(out)).toEqual({
      staged: ["staged.ts", "both.ts", "to.ts"],
      unstaged: ["unstaged.ts", "both.ts"],
      untracked: ["new.ts"],
    });
  });
});

describe("ids, json, contracts", () => {
  test("ids are prefixed and time-sortable", () => {
    const a = newId("op", new Date(1_000));
    const b = newId("op", new Date(2_000));
    expect(a).toMatch(/^op_[0-9a-z]{22}$/);
    expect(a < b).toBe(true);
  });

  test("canonicalJson sorts keys; parseJsonc tolerates comments and trailing commas", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "//not a comment", }')).toEqual({
      a: [1, 2],
      b: "//not a comment",
    });
    expect(sha256Of("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("every registered contract renders a JSON Schema with its published $id", () => {
    const names = new Set<string>();
    for (const entry of CONTRACTS) {
      const schema = contractJsonSchema(entry);
      expect(schema.$id).toBe(
        `https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/v2/${entry.name}.schema.json`,
      );
      expect(names.has(entry.name)).toBe(false);
      names.add(entry.name);
    }
  });
});
