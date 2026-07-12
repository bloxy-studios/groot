/**
 * Electron adapter — docs/scaffold-flows.md#9. The second desktop-slot scaffold.
 *
 * Uses electron-vite's scaffolder `@quick-start/create-electron` (the de-facto
 * standard for Electron + Vite + TS; Forge's own create-electron-app force-
 * installs dependencies with npm/yarn and cannot be silenced — see the
 * expansion research). With a `-ts` template and `--skip` every prompt is
 * suppressed; it never installs and never git-inits. Like create-tauri-app,
 * the positional is a NAME the generator derives fields from, so the spawn
 * runs from the scaffold's parent directory with the bare basename.
 *
 * The one bun-specific nuance: the `electron` package downloads its binary in
 * a postinstall script, and bun runs dependency lifecycle scripts only for
 * trusted packages — electron is NOT on bun's default-trusted list (verified
 * empirically: the flagship E2E's real `bun install` left the runtime missing
 * until the stitch fix landed). The stitch stage therefore writes
 * trustedDependencies: ["electron"] into the workspace root package.json
 * (stitchTrustedDependencies), and the flagship E2E asserts the runtime
 * arrives (node_modules/electron/dist). The doctor check below catches the
 * blocked state in hand-edited workspaces with a `bun pm trust` fix.
 *
 * No declared dev port: electron-vite's renderer dev server is non-strict and
 * self-wiring (Electron is launched with whatever URL it resolved), unlike
 * Tauri's contractual strictPort 1420.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AdapterContext,
  DoctorCheck,
  DoctorContext,
  GeneratorCommand,
  ScaffoldAdapter,
} from "../engine/adapter.ts";

/** Pinned template — TypeScript + React renderer (see docs/scaffold-flows.md#9). */
export const ELECTRON_TEMPLATE = "react-ts";

/**
 * Resolve electron's installed package directory FROM the scaffold directory.
 * Layout-agnostic on purpose: bun 1.3's isolated installs keep packages in the
 * node_modules/.bun store with symlinks in the *declaring* workspace member —
 * there is no top-level node_modules/electron. Node resolution from the app
 * dir finds it under any layout; null when electron isn't installed.
 */
export function resolveElectronPackageDir(scaffoldAbsDir: string): string | null {
  try {
    return dirname(Bun.resolveSync("electron/package.json", scaffoldAbsDir));
  } catch {
    return null;
  }
}

export const electronAdapter: ScaffoldAdapter = {
  id: "electron",
  slot: "desktop",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    return {
      argv: [
        "bunx",
        "@quick-start/create-electron@1",
        name,
        "--template",
        ELECTRON_TEMPLATE,
        "--skip",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory (apps/) exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Electron)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const checks: DoctorCheck[] = [];

    // electron.vite.config — the template's contract (main/preload/renderer).
    const configPresent = ["electron.vite.config.ts", "electron.vite.config.mjs"].some((file) =>
      existsSync(join(base, file)),
    );
    checks.push({
      name: `${ctx.scaffold.path} electron-vite config`,
      status: configPresent ? "pass" : "fail",
      detail: configPresent
        ? "electron.vite.config present"
        : "no electron.vite.config.{ts,mjs} found",
      ...(configPresent
        ? {}
        : {
            fix: `Restore ${ctx.scaffold.path}/electron.vite.config.ts (required by electron-vite dev/build).`,
          }),
    });

    // Electron's postinstall downloads the runtime binary into dist/. Bun only
    // runs trusted dependency lifecycle scripts — if the package is installed
    // but dist/ is missing, the postinstall was blocked or interrupted.
    // Resolved from the scaffold dir (isolated-layout safe, see helper above).
    const electronPkgDir = resolveElectronPackageDir(base);
    if (electronPkgDir !== null) {
      const binaryPresent = existsSync(join(electronPkgDir, "dist"));
      checks.push({
        name: `${ctx.scaffold.path} electron binary`,
        status: binaryPresent ? "pass" : "warn",
        detail: binaryPresent
          ? "electron runtime downloaded (dist/ present in the installed package)"
          : "electron installed but its runtime is missing — the postinstall didn't run",
        ...(binaryPresent ? {} : { fix: "Run `bun pm trust electron` at the workspace root." }),
      });
    }

    return checks;
  },
};
