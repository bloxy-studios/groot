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
      { port: 3000, script: "dev" },
      { port: 8080, script: "start" },
      { port: 4173, script: "preview" },
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
