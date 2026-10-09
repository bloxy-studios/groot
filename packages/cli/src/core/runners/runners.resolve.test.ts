/**
 * Real executable resolution in scratch directories: an explicit override is
 * honored exactly, cmux shims and exec-wrapper scripts on PATH are skipped
 * (and noted) in favor of the real binary, and the Codex npm launcher resolves
 * to its native vendor binary with the PATH prepend it would have set.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexNativeBehindLauncher, isWrapperShim, resolveExecutable } from "./resolve.ts";

describe("executable resolution", () => {
  function scratch(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "groot-resolve-")));
  }

  function script(path: string, body: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  test("an explicit GROOT_CLAUDE_PATH is honored exactly", () => {
    const dir = scratch();
    const exe = script(join(dir, "my-claude"), "#!/bin/sh\nexit 0\n");
    const resolution = resolveExecutable("claude-code", { GROOT_CLAUDE_PATH: exe, PATH: "" });
    expect(resolution.executable).toMatchObject({ path: exe, kind: "override" });
    expect(
      resolveExecutable("claude-code", { GROOT_CLAUDE_PATH: join(dir, "missing"), PATH: "" })
        .executable,
    ).toBeNull();
  });

  test("cmux shims and exec-wrapper scripts on PATH are skipped (and noted) in favor of the real binary", () => {
    // Arrange
    const dir = scratch();
    const shimDir = join(dir, "cmux-cli-shims", "ABC");
    script(
      join(shimDir, "claude"),
      '#!/usr/bin/env bash\nexec "/Applications/cmux.app/x/cmux-claude-wrapper" "$@"\n',
    );
    const wrapperDir = join(dir, "wrapped");
    script(join(wrapperDir, "claude"), '#!/bin/sh\nexec "$HOME/bin/claude-wrapper" "$@"\n');
    const realDir = join(dir, "real");
    const real = script(join(realDir, "claude"), "#!/bin/sh\necho real\n");

    // Act
    const resolution = resolveExecutable("claude-code", {
      PATH: [shimDir, wrapperDir, realDir].join(":"),
    });

    // Assert
    expect(resolution.executable?.path).toBe(real);
    expect(resolution.notes.filter((note) => note.startsWith("skipped wrapper shim"))).toHaveLength(
      2,
    );
    expect(isWrapperShim("/x/cmux-cli-shims/1/codex", "")).toBe(true);
    expect(isWrapperShim("/usr/bin/claude", "#!/usr/bin/env node\nrequire('cli.js')")).toBe(false);
  });

  test("only wrappers on PATH → not found, with a hint to set the override", () => {
    const dir = scratch();
    const shimDir = join(dir, "cmux-cli-shims", "A");
    script(join(shimDir, "codex"), '#!/bin/bash\nexec cmux-codex-wrapper "$@"\n');
    const resolution = resolveExecutable("codex", { PATH: shimDir });
    expect(resolution.executable).toBeNull();
    expect(resolution.notes.join(" ")).toContain("GROOT_CODEX_PATH");
  });

  test("the Codex npm launcher resolves to the native vendor binary with its PATH prepend", () => {
    // Arrange
    const triples: Record<string, string> = {
      "darwin-x64": "x86_64-apple-darwin",
      "darwin-arm64": "aarch64-apple-darwin",
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
    };
    const triple = triples[`${process.platform}-${process.arch}`];
    if (triple === undefined) return;
    const dir = scratch();
    const modules = join(dir, "install", "global", "node_modules", "@openai");
    const launcher = script(
      join(modules, "codex", "bin", "codex.js"),
      "#!/usr/bin/env node\n// launcher\n",
    );
    const vendor = join(modules, `codex-${process.platform}-${process.arch}`, "vendor", triple);
    const native = script(join(vendor, "codex", "codex"), "#!/bin/sh\necho native\n");
    mkdirSync(join(vendor, "path"), { recursive: true });
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(launcher, join(binDir, "codex"));

    // Act
    const resolution = resolveExecutable("codex", { PATH: binDir });

    // Assert
    expect(codexNativeBehindLauncher(launcher)?.path).toBe(native);
    expect(resolution.executable).toMatchObject({
      path: native,
      kind: "native",
      prependPath: [join(vendor, "path")],
    });
    expect(resolution.notes.join(" ")).toContain("native Codex binary behind the npm launcher");
  });
});
