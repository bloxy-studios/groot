/**
 * Foundation contracts: project-boundary enforcement (incl. symlinks), atomic
 * writes, the writer lock (exclusive, stale takeover, live refusal),
 * redaction, git porcelain parsing, ids, and the contract registry.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("refuses a path whose symlinked parent points outside the project", () => {
    const root = scratch();
    const outside = scratch();
    symlinkSync(outside, join(root, "linked"));
    expect(() => resolveInProject(root, "linked/new-file.ts")).toThrow(/symlink/);
    mkdirSync(join(root, "real"));
    expect(resolveInProject(root, "real/new-file.ts")).toBe(join(root, "real/new-file.ts"));
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
