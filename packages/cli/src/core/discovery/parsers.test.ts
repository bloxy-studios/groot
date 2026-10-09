/**
 * The static readers discovery relies on — scripts, entry sources, dotenv
 * files, pnpm-workspace.yaml — parsed as text and never executed.
 */
import { describe, expect, test } from "bun:test";
import { envNames } from "./env-files.ts";
import { APP_FRAMEWORKS, isConfigPackage, matchFramework } from "./frameworks.ts";
import { declaredManagerName } from "./package-manager.ts";
import {
  entryCandidates,
  parseCommand,
  runtimeSignals,
  scriptPorts,
  sourcePorts,
  startsServer,
  tokenizeScript,
} from "./scripts.ts";
import { parseVersion } from "./toolchains.ts";
import { parsePnpmWorkspace } from "./workspaces.ts";

describe("script entries", () => {
  test.each([
    ["bun --watch src/index.ts", "src/index.ts", "bun"],
    ["bun run server/main.ts", "server/main.ts", "bun"],
    ["bun run --hot src/index.ts", "src/index.ts", "bun"],
    ["tsx watch src/server.ts", "src/server.ts", "tsx"],
    ["NODE_ENV=production node -r dotenv/config ./dist/../src/x.js", null, "node"],
    ["cross-env PORT=4000 node --env-file .env src/app.js", "src/app.js", "node"],
    ["bunx tsx watch src/main.ts", "src/main.ts", "tsx"],
    ["bun x --bun tsx watch src/main.ts", "src/main.ts", "tsx"],
  ])("%s → %s", (script, file, runner) => {
    // Arrange
    const scripts = { dev: script };

    // Act
    const candidates = entryCandidates(scripts);

    // Assert
    if (file === null) {
      expect(candidates).toEqual([]);
    } else {
      expect(candidates[0]).toEqual({ file, script: "dev", runner });
    }
  });

  test("follows `bun run <script>` references and prefers dev over start", () => {
    // Arrange
    const scripts = {
      start: "bun src/prod.ts",
      dev: "bun run dev:api",
      "dev:api": "bun --hot apps/server.ts",
      test: "bun test",
    };

    // Act
    const files = entryCandidates(scripts).map((candidate) => candidate.file);

    // Assert
    expect(files).toEqual(["apps/server.ts", "src/prod.ts", "apps/server.ts"]);
  });

  test("tooling subcommands and framework CLIs are not entries", () => {
    // Arrange / Act / Assert
    expect(
      entryCandidates({ dev: "next dev --turbopack", start: "bun test", serve: "vite" }),
    ).toEqual([]);
  });

  test("tokenizer honors quotes and splits shell operators", () => {
    // Arrange / Act
    const commands = tokenizeScript(`echo "a && b" && PORT=1 bun 'src/my file.ts'; vite | cat`);

    // Assert
    expect(commands).toEqual([
      ["echo", "a && b"],
      ["PORT=1", "bun", "src/my file.ts"],
      ["vite"],
      ["cat"],
    ]);
    expect(parseCommand(commands[1] as string[])).toEqual({
      runner: "bun",
      launcherFlags: [],
      args: ["src/my file.ts"],
      envPort: 1,
    });
  });
});

describe("ports", () => {
  test("scripts: --port N, --port=N, -p N, PORT=N (first owner wins, dev first)", () => {
    // Arrange
    const scripts = {
      preview: "vite preview --port=4173",
      dev: "next dev -p 3000",
      start: "PORT=8080 bun src/index.ts",
      typecheck: "tsc -p tsconfig.json",
      docker: "docker run -p 8080:80 app",
    };

    // Act
    const ports = scriptPorts(scripts);

    // Assert
    expect(ports).toEqual([
      { port: 3000, script: "dev", app: true, runs: [] },
      { port: 8080, script: "start", app: true, runs: ["src/index.ts"] },
      { port: 4173, script: "preview", app: false, runs: [] },
    ]);
  });

  test("only dev/start/serve and what they `bun run` declare the app's port; a tool's is its own", () => {
    // Arrange
    const scripts = {
      dev: "bun run server",
      server: "bun --watch src/index.ts --port 4000",
      start: "bun run start:prod",
      "start:prod": "PORT=8787 bun src/index.ts",
      "dev:email": "email dev --port 3001",
      "db:studio": "drizzle-kit studio --port 4983",
      storybook: "storybook dev -p 6006",
    };

    // Act
    const ports = scriptPorts(scripts);

    // Assert
    expect(ports).toEqual([
      { port: 4000, script: "server", app: true, runs: ["src/index.ts"] },
      { port: 8787, script: "start:prod", app: true, runs: ["src/index.ts"] },
      { port: 3001, script: "dev:email", app: false, runs: [] },
      { port: 4983, script: "db:studio", app: false, runs: [] },
      { port: 6006, script: "storybook", app: false, runs: [] },
    ]);
  });

  test("a tool's CLI never declares the app's port, even when the app's own dev script starts it", () => {
    // Arrange: directly, through bunx or `bun x`, or as a `bun run` of a tool-only script.
    const scripts = {
      dev: "bun run db:studio & storybook dev -p 6006 & bun x prisma studio -p 5555 & bun --hot src/index.ts",
      start: "PORT=4984 bun run db:studio",
      "db:studio": "drizzle-kit studio --port 4983",
    };

    // Act
    const ports = scriptPorts(scripts);

    // Assert
    expect(ports).toEqual([
      { port: 6006, script: "dev", app: false, runs: [] },
      { port: 5555, script: "dev", app: false, runs: [] },
      { port: 4983, script: "db:studio", app: false, runs: [] },
      { port: 4984, script: "start", app: false, runs: [] },
    ]);
  });

  test("a command running a source file declares the app's port in any dev/start/serve-style script", () => {
    // Arrange: the entry comes from dev:api, so its port is the app's; dev:* tools stay tools.
    const scripts = {
      "dev:web": "next dev -p 3001",
      "dev:email": "email dev --port 3002",
      "dev:api": "PORT=4000 bun --watch src/server.ts",
    };

    // Act
    const ports = scriptPorts(scripts);

    // Assert
    expect(ports).toEqual([
      { port: 4000, script: "dev:api", app: true, runs: ["src/server.ts"] },
      { port: 3002, script: "dev:email", app: false, runs: [] },
      { port: 3001, script: "dev:web", app: false, runs: [] },
    ]);
  });

  test("`PORT=N bun run <script>`: the port belongs to what that script runs", () => {
    // Arrange
    const scripts = { dev: "PORT=4100 bun run server", server: "bun --watch src/index.ts" };

    // Act / Assert
    expect(scriptPorts(scripts)).toEqual([
      { port: 4100, script: "dev", app: true, runs: ["src/index.ts"] },
    ]);
  });

  test("entry source: listen, PORT ?? N, PORT || N, const PORT = N, port: N", () => {
    // Arrange
    const sources = {
      listen: "app.listen(3005, () => {});",
      nullish: "const port = Number(process.env.PORT ?? 4310);",
      or: "const port = Number(process.env.PORT) || 3006;",
      constant: "const PORT = 3007;",
      object: "export default { port: 3008, fetch: app.fetch };",
      comment: "// app.listen(9999)\n/* port: 9998 */\nBun.serve({ port: 3009, fetch })",
    };

    // Act / Assert
    expect(sourcePorts(sources.listen)).toEqual([3005]);
    expect(sourcePorts(sources.nullish)).toEqual([4310]);
    expect(sourcePorts(sources.or)).toEqual([3006]);
    expect(sourcePorts(sources.constant)).toEqual([3007]);
    expect(sourcePorts(sources.object)).toEqual([3008]);
    expect(sourcePorts(sources.comment)).toEqual([3009]);
  });

  test("server-starting entries are recognized", () => {
    // Arrange / Act / Assert
    expect(startsServer("Bun.serve({ fetch })")).toBe(true);
    expect(startsServer("export default { port, fetch: app.fetch };")).toBe(true);
    expect(startsServer("export const add = (a, b) => a + b;")).toBe(false);
  });
});

describe("runtime signals", () => {
  test("bun vs node file runners, and the --bun opt-in", () => {
    // Arrange / Act / Assert
    expect(runtimeSignals({ dev: "bun --watch src/index.ts" })).toEqual({
      bunFile: true,
      nodeFile: false,
      bunFlag: false,
    });
    expect(runtimeSignals({ dev: "tsx watch src/server.ts" })).toEqual({
      bunFile: false,
      nodeFile: true,
      bunFlag: false,
    });
    expect(runtimeSignals({ dev: "bunx --bun next dev" }).bunFlag).toBe(true);
    expect(runtimeSignals({ dev: "next dev" })).toEqual({
      bunFile: false,
      nodeFile: false,
      bunFlag: false,
    });
  });
});

describe("dotenv names", () => {
  test("returns names only, skipping comments and multi-line values", () => {
    // Arrange
    const text = [
      "# comment=ignored",
      "export TOKEN=abc",
      "EMPTY=",
      'PRIVATE_KEY="-----BEGIN KEY-----',
      "line=inside-the-value",
      '-----END KEY-----"',
      "AFTER=1",
      "TOKEN=again",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual(["TOKEN", "EMPTY", "PRIVATE_KEY", "AFTER"]);
    expect(JSON.stringify(names)).not.toContain("abc");
  });

  test("key material in an unquoted PEM or other armored block never becomes a name", () => {
    // Arrange: base64 lines ending in padding look like `name=` assignments.
    const text = [
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "kSECRETfragmentXYZ==",
      "qSECRETtail=",
      "-----END PRIVATE KEY-----",
      "CERT_NAME=web",
      "-----BEGIN CERTIFICATE-----",
      "cSECRETcert=",
      "-----END CERTIFICATE-----",
      "INLINE_PEM=-----BEGIN KEY-----abc-----END KEY-----",
      "AFTER=1",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual(["PRIVATE_KEY", "CERT_NAME", "INLINE_PEM", "AFTER"]);
    expect(names.join("\n")).not.toContain("SECRET");
  });

  test("a BEGIN marker in a comment or a closed quoted value does not hide later names", () => {
    // Arrange
    const text = [
      "# paste the key as one line: -----BEGIN PRIVATE KEY----- …",
      'ONE_LINE_KEY="-----BEGIN PRIVATE KEY-----\\nabc\\n"',
      "NOTE=see docs # format: -----BEGIN CERTIFICATE-----",
      "-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----",
      "aSECRET=",
      "-----END CERTIFICATE----- -----BEGIN CERTIFICATE-----",
      "bSECRET=",
      "-----END CERTIFICATE-----",
      "AFTER=1",
    ].join("\n");

    // Act / Assert
    expect(envNames(text)).toEqual(["ONE_LINE_KEY", "NOTE", "AFTER"]);
  });

  test("a base64 padding tail outside any block is not an assignment", () => {
    // Arrange: an unquoted, line-wrapped base64 value ends in a padded line.
    const text = ["BLOB=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo", "bSECRETpadding==", "AFTER=1"].join(
      "\n",
    );

    // Act / Assert
    expect(envNames(text)).toEqual(["BLOB", "AFTER"]);
  });

  test("a single-`=` base64 padding tail is not a name; ordinary empty assignments still are", () => {
    // Arrange: `<base64>=` reads as an empty assignment (Bun defines it), but a key with
    // letters of both cases and digits and no underscore is encoded data, not a name.
    const text = [
      "SIGNING_KEY=MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq7BFUpkGp3XQjHxm",
      "k3Yz8N4fQ2v1Rk5h9wq7aVxk3dLkmZ0yQcK9pWQIDAQABAkBYsecretTail=",
      "Zm9vYmFy0x9=",
      "EMPTY=",
      "API_V2=",
      "lower_case=",
      "nodeEnv=",
      "LEGACY2=",
      "AFTER=1",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual([
      "SIGNING_KEY",
      "EMPTY",
      "API_V2",
      "lower_case",
      "nodeEnv",
      "LEGACY2",
      "AFTER",
    ]);
    expect(names.join("\n")).not.toMatch(/secret|Zm9v/);
  });

  test("a quoted value spanning lines is skipped whole, whatever its key looks like", () => {
    // Arrange: dotenv accepts keys with dashes and dots; groot reports only identifiers.
    const text = [
      'my-key="first line',
      "qSECRETinside=value",
      'last line"',
      "app.token='a",
      "tSECRETinside=1",
      "'",
      "AFTER=1",
    ].join("\n");

    // Act / Assert
    expect(envNames(text)).toEqual(["AFTER"]);
  });

  test("a `KEY: value` (colon) assignment is a name, and its quoted value spanning lines is skipped", () => {
    // Arrange: Bun's .env loader accepts a colon followed by whitespace as the separator.
    const text = [
      "DATABASE_URL=postgres://localhost/db",
      'SIGNING_KEY: "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq7BFUpkGp3XQjHxm',
      'k3Yz8N4fQ2v1Rk5h9wq7aVxk3dLkmZ0yQcK9pWQIDAQABAkBYsecretTail="',
      'export COLON_ML : "first',
      "INSIDE_COLON=1",
      'last"',
      "TABBED:\t'a",
      "tSECRET=1",
      "'",
      "PEM: -----BEGIN PRIVATE KEY-----",
      "kSECRETfragment=",
      "-----END PRIVATE KEY-----",
      "AFTER=1",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual(["DATABASE_URL", "SIGNING_KEY", "COLON_ML", "TABBED", "PEM", "AFTER"]);
    expect(names.join("\n")).not.toMatch(/SECRET|secret|INSIDE/);
  });

  test("`KEY:` ending a line takes the next line as its value; a colon needs whitespace after it", () => {
    // Arrange: as in Bun's loader — after `KEY:` and \n (or a lone \r) the next line is the value;
    // after \r\n the value is empty; `KEY:"…"`, or `KEY:` ending the text, is no assignment at all.
    const text = [
      "NEXT_LINE:",
      "vSECRET=1",
      "QUOTED_NEXT:",
      "'first",
      "qSECRET=1",
      "'",
      "ARMORED:",
      "-----BEGIN PRIVATE KEY-----",
      "aSECRET=",
      "-----END PRIVATE KEY-----",
      "LONE_CR:\rcSECRET=1",
      "CRLF_EMPTY:\r\nREAL=1\r",
      'NOSPACE:"not a value',
      "SEEN=1",
      "AFTER=1",
      "AT_END:",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual([
      "NEXT_LINE",
      "QUOTED_NEXT",
      "ARMORED",
      "LONE_CR",
      "CRLF_EMPTY",
      "REAL",
      "SEEN",
      "AFTER",
    ]);
    expect(names.join("\n")).not.toContain("SECRET");
  });

  test("a backslash escapes the next character inside every kind of quote", () => {
    // Arrange: `\'` and `` \` `` do not close their quotes (Bun's loader); `\\` before a quote does.
    const text = [
      "WIN_PATH='C:\\Users\\'",
      "secretLine=abc",
      "'",
      "TPL=`a \\` b",
      "bSECRET=1",
      "last`",
      'DQ="a \\" b',
      "dSECRET=1",
      'last"',
      "DOUBLE_BACKSLASH='C:\\\\'",
      "NEXT=1",
      "AFTER=1",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual(["WIN_PATH", "TPL", "DQ", "DOUBLE_BACKSLASH", "NEXT", "AFTER"]);
    expect(names.join("\n")).not.toMatch(/SECRET|secret/);
  });

  test("an empty value takes a quoted value opening on the next non-blank line", () => {
    // Arrange: Bun's loader skips blank lines after `KEY=` / `KEY: ` looking for an opening quote.
    const text = [
      "EMPTY_THEN_QUOTE=",
      "",
      "   ",
      '  "first',
      "eSECRET=1",
      'last"',
      "SPACED_COLON: ",
      "'a",
      "cSECRET=1",
      "'",
      "CRLF_COLON:\r",
      "`x",
      "rSECRET=1",
      "`",
      "BLANK_THEN_LINE:",
      "",
      "  'b",
      "lSECRET=1",
      "'",
      "EMPTY_THEN_PLAIN=",
      "PLAIN=1",
      "EMPTY_THEN_COMMENT=",
      "# 'not a value",
      "SEEN=1",
      "AFTER=1",
    ].join("\n");

    // Act
    const names = envNames(text);

    // Assert
    expect(names).toEqual([
      "EMPTY_THEN_QUOTE",
      "SPACED_COLON",
      "CRLF_COLON",
      "BLANK_THEN_LINE",
      "EMPTY_THEN_PLAIN",
      "PLAIN",
      "EMPTY_THEN_COMMENT",
      "SEEN",
      "AFTER",
    ]);
    expect(names.join("\n")).not.toContain("SECRET");
  });

  test("a lone carriage return ends a line, so the quote it precedes is tracked", () => {
    // Arrange
    const text = 'A=x\rB="abc\nlSECRET=1\n"\nAFTER=1';

    // Act / Assert
    expect(envNames(text)).toEqual(["A", "B", "AFTER"]);
  });
});

describe("pnpm-workspace.yaml", () => {
  test("block list with quotes and comments", () => {
    // Arrange
    const text =
      "packages:\n  - 'apps/*' # apps\n  - \"packages/*\"\n  - tools/cli\ncatalog:\n  react: ^19\n";

    // Act / Assert
    expect(parsePnpmWorkspace(text)).toEqual(["apps/*", "packages/*", "tools/cli"]);
  });

  test("flow list, and no packages key", () => {
    // Arrange / Act / Assert
    expect(parsePnpmWorkspace('packages: ["apps/*", "libs/**"]\n')).toEqual(["apps/*", "libs/**"]);
    expect(parsePnpmWorkspace("catalog:\n  react: ^19\n")).toBeNull();
  });

  test("block list with zero indentation, ended by the next top-level key", () => {
    // Arrange: YAML allows a mapping's sequence at the key's own indentation.
    const text =
      "packages:\n- apps/*\n- 'packages/*' # shared\n\n- tools/cli\nonlyBuiltDependencies:\n- esbuild\n";

    // Act / Assert
    expect(parsePnpmWorkspace(text)).toEqual(["apps/*", "packages/*", "tools/cli"]);
    expect(parsePnpmWorkspace("packages:\n- apps/*\n...\n- ignored/*\n")).toEqual(["apps/*"]);
  });
});

describe("small classifiers", () => {
  test("config presets by package or directory name", () => {
    // Arrange / Act / Assert
    expect(isConfigPackage("@repo/typescript-config", "packages/typescript-config")).toBe(true);
    expect(isConfigPackage("eslint-config-acme", "tooling/lint")).toBe(true);
    expect(isConfigPackage("@repo/ui", "packages/ui")).toBe(false);
    expect(isConfigPackage(null, "packages/tailwind-config")).toBe(true);
  });

  test("wrappers win: tauri over vite+react, next over hono", () => {
    // Arrange / Act / Assert
    expect(
      matchFramework(APP_FRAMEWORKS, { vite: "^7", react: "^19", "@tauri-apps/cli": "^2" })?.rule
        .id,
    ).toBe("tauri");
    expect(matchFramework(APP_FRAMEWORKS, { next: "^16", hono: "^4" })?.rule.id).toBe("next");
    expect(matchFramework(APP_FRAMEWORKS, { "react-router": "^7" })).toBeNull();
  });

  test("packageManager field and tool banners", () => {
    // Arrange / Act / Assert
    expect(declaredManagerName("pnpm@9.12.0+sha512.abc")).toBe("pnpm");
    expect(declaredManagerName("bun")).toBeNull();
    expect(parseVersion("cargo 1.79.0 (ffa9cf99a 2024-06-03)")).toBe("1.79.0");
    expect(parseVersion('openjdk version "21.0.2" 2024-01-16')).toBe("21.0.2");
    expect(parseVersion("go version go1.22.1 darwin/amd64")).toBe("1.22.1");
    expect(parseVersion("Xcode 16.0\nBuild version 16A242d")).toBe("16.0");
  });
});
