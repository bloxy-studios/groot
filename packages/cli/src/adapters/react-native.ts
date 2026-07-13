/**
 * Bare React Native adapter — docs/scaffold-flows.md#16. Second mobile-slot
 * choice, riding the official `@react-native-community/cli init` (all facts
 * verified against the published 20.2.0 bundle and the 0.86.0 community
 * template).
 *
 * With `--pm bun --skip-install --install-pods false --skip-git-init` the init
 * is fully non-interactive on a fresh target: it resolves the react-native
 * version and matching `@react-native-community/template` via plain registry
 * fetches, installs the template with BUN into the CLI's own tempdir, copies
 * it into the target, and rewrites the `HelloWorld` placeholders to the
 * project name (also renaming `_gitignore` → `.gitignore` and friends —
 * UNDERSCORED_DOTFILES in editTemplate.js). CocoaPods runs only on macOS and
 * only inside the (skipped) install step; git init is flag-skipped. Xcode /
 * CocoaPods / Android SDK remain build-time concerns for the user's machine —
 * never groot's.
 *
 * stagedGeneration is load-bearing here: the CLI's registry-URL lookup shells
 * `npm config get registry`, which hard-fails with EBADDEVENGINES inside a
 * bun-declared workspace (verified empirically — only a courtesy try/catch
 * saves init, at the cost of forcing the hardcoded default registry). Staged
 * under the OS tempdir the lookup succeeds and the user's real registry
 * config is honored.
 *
 * The template's scripts are package-manager-neutral (`react-native start`,
 * `jest`, …) so none are rewritten — the expo precedent. What bare RN does
 * need is the metro monorepo patch (watchFolders + workspace module
 * resolution), applied by the stitch stage: unlike Expo (auto-configured
 * since SDK 52), bare metro resolves nothing outside the app directory.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

/** Marker the stitch writes into metro.config.js — the doctor watches for it. */
export const METRO_MONOREPO_MARKER = "groot: monorepo wiring";

/**
 * init's project-name rules, mirrored from the published 20.2.0 bundle
 * (commands/init/validate.js) so `groot add --path` refuses up front what the
 * generator would crash on mid-generate: JS-identifier shape, no java
 * keywords (the name becomes the android package segment), no "react" /
 * "react-native", nothing containing "helloworld" (the template placeholder).
 */
const RN_NAME_REGEX = /^[$A-Z_][0-9A-Z_$]*$/i;
const JAVA_KEYWORDS = [
  "abstract",
  "continue",
  "for",
  "new",
  "switch",
  "assert",
  "default",
  "goto",
  "package",
  "synchronized",
  "boolean",
  "do",
  "if",
  "private",
  "this",
  "break",
  "double",
  "implements",
  "protected",
  "throw",
  "byte",
  "else",
  "import",
  "public",
  "throws",
  "case",
  "enum",
  "instanceof",
  "return",
  "transient",
  "catch",
  "extends",
  "int",
  "short",
  "try",
  "char",
  "final",
  "interface",
  "static",
  "void",
  "class",
  "finally",
  "long",
  "strictfp",
  "volatile",
  "const",
  "float",
  "native",
  "super",
  "while",
];
const RN_RESERVED_NAMES = new Set(["react", "react-native", ...JAVA_KEYWORDS]);

/** The generator-rule error for a proposed basename, or null when it passes. */
export function reactNativeNameError(name: string): string | null {
  if (!RN_NAME_REGEX.test(name)) {
    return `"${name}" is not a valid React Native project name — the RN CLI derives the native project identifiers from it and only allows letters, digits, "$" and "_" (not starting with a digit).`;
  }
  if (RN_RESERVED_NAMES.has(name.toLowerCase())) {
    return `"${name}" is reserved by the React Native CLI (java keywords, "react" and "react-native" can't name a project).`;
  }
  if (/helloworld/i.test(name)) {
    return `"${name}" contains "HelloWorld", the RN template's placeholder — the CLI refuses it.`;
  }
  return null;
}

export const reactNativeAdapter: ScaffoldAdapter = {
  id: "react-native",
  slot: "mobile",
  // init's registry lookup shells npm, which trips the workspace's bun
  // devEngines guard in-tree (EBADDEVENGINES) — stage it under the OS tempdir.
  stagedGeneration: true,
  validatePath(path: string): string | null {
    const error = reactNativeNameError(basename(path));
    return error === null
      ? null
      : `${path}: ${error} Pick a --path whose last segment is a valid name, e.g. apps/companion.`;
  },
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "@react-native-community/cli@20",
        "init",
        // The positional is both the created directory and the native project
        // name (android applicationId com.<name>, iOS target) after
        // placeholder replacement — "mobile" passes the CLI's name validation.
        name,
        "--pm",
        "bun",
        "--skip-install",
        "--install-pods",
        "false",
        "--skip-git-init",
        "--replace-directory",
        "false",
      ],
      // Superseded by the staging directory (see stagedGeneration).
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (React Native)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    // Without the monorepo wiring, metro can't watch shared packages or
    // resolve modules bun hoists to the workspace root — apps break at
    // runtime with "Unable to resolve module" errors that look unrelated.
    const name = `${ctx.scaffold.path} metro monorepo wiring`;
    const configPath = join(ctx.workspaceRoot, ctx.scaffold.path, "metro.config.js");
    if (!existsSync(configPath)) {
      return [
        {
          name,
          status: "fail",
          detail: "metro.config.js missing",
          fix: `Restore ${ctx.scaffold.path}/metro.config.js or remove the scaffold from groot.json.`,
        },
      ];
    }
    const source = await readFile(configPath, "utf8");
    const wired = source.includes(METRO_MONOREPO_MARKER) || source.includes("watchFolders");
    return [
      {
        name,
        status: wired ? "pass" : "warn",
        detail: wired
          ? "metro.config.js carries the workspace wiring"
          : "metro.config.js has no workspace wiring (watchFolders / nodeModulesPaths)",
        ...(wired
          ? {}
          : {
              fix: "Add watchFolders: [workspaceRoot] and resolver.nodeModulesPaths for the app and workspace root to metro.config.js.",
            }),
      },
    ];
  },
};
