/**
 * Tauri (v2) adapter — docs/scaffold-flows.md#8. The first desktop-slot scaffold.
 *
 * create-tauri-app is fully non-interactive with `--yes` and never installs or
 * git-inits. It is invoked with the scaffold's PARENT as cwd and the bare
 * directory name as the positional (the generator derives app/crate names from
 * it — a path with slashes is not a safe name source). The template's Vite dev
 * server is pinned to port 1420 with strictPort, and src-tauri/tauri.conf.json
 * points its devUrl at the same port — unique in groot's matrix, so it is kept.
 *
 * Rust (cargo) is required to RUN `tauri dev`/`tauri build`, but not to
 * scaffold: generation is pure npm. groot therefore scaffolds without checking
 * for Rust, prints a rustup next-step, and `doctor` warns when cargo is absent.
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

/** Pinned template — TypeScript + React frontend (see docs/scaffold-flows.md#8). */
export const TAURI_TEMPLATE = "react-ts";

/**
 * Build a reverse-domain bundle identifier segment: lowercase, alphanumerics
 * and hyphens only, never empty. Tauri requires identifiers matching
 * [a-zA-Z0-9-.]+ and warns on the default `com.tauri.dev`.
 */
export function identifierSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return cleaned === "" ? "app" : cleaned;
}

export const tauriAdapter: ScaffoldAdapter = {
  id: "tauri",
  slot: "desktop",
  command(ctx: AdapterContext): GeneratorCommand {
    const name = basename(ctx.scaffold.path);
    const identifier = `com.${identifierSegment(ctx.plan.name)}.${identifierSegment(name)}`;
    return {
      argv: [
        "bunx",
        "create-tauri-app@4",
        name,
        "--template",
        TAURI_TEMPLATE,
        "--manager",
        "bun",
        "--identifier",
        identifier,
        "--yes",
      ],
      // The generator creates `<name>` under cwd; growScaffold guarantees the
      // parent directory (apps/) exists before any command runs.
      cwd: join(ctx.plan.targetDir, dirname(ctx.scaffold.path)),
      label: `Growing ${ctx.scaffold.path} (Tauri)`,
    };
  },
  async doctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
    const base = join(ctx.workspaceRoot, ctx.scaffold.path);
    const checks: DoctorCheck[] = [];

    // tauri.conf.json present and parseable — the desktop shell's contract.
    const confPath = join(base, "src-tauri", "tauri.conf.json");
    let conf: Record<string, unknown> | null = null;
    try {
      conf = JSON.parse(await readFile(confPath, "utf8")) as Record<string, unknown>;
    } catch {
      conf = null;
    }
    checks.push({
      name: `${ctx.scaffold.path} tauri config`,
      status: conf !== null ? "pass" : "fail",
      detail:
        conf !== null
          ? "src-tauri/tauri.conf.json present"
          : "src-tauri/tauri.conf.json missing or unparseable",
      ...(conf !== null
        ? {}
        : {
            fix: `Restore ${ctx.scaffold.path}/src-tauri/tauri.conf.json (tauri.conf.json is required by tauri dev/build).`,
          }),
    });

    // devUrl still points at the assigned port (template couples vite + conf).
    if (conf !== null && ctx.scaffold.port !== null) {
      const build =
        typeof conf.build === "object" && conf.build !== null
          ? (conf.build as Record<string, unknown>)
          : {};
      const devUrl = typeof build.devUrl === "string" ? build.devUrl : "";
      // Parse the actual port — a substring test would accept :14200 for :1420.
      let devUrlPort: number | null = null;
      try {
        const parsed = new URL(devUrl);
        devUrlPort = parsed.port === "" ? null : Number(parsed.port);
      } catch {
        devUrlPort = null;
      }
      const matches = devUrlPort === ctx.scaffold.port;
      checks.push({
        name: `${ctx.scaffold.path} dev port`,
        status: matches ? "pass" : "warn",
        detail: matches
          ? `devUrl serves on :${ctx.scaffold.port}`
          : `devUrl "${devUrl}" no longer matches groot.json's port :${ctx.scaffold.port}`,
        ...(matches
          ? {}
          : {
              fix: "If the change is intentional, update the port in groot.json to match (and keep vite.config strictPort in sync).",
            }),
      });
    }

    // Rust toolchain — needed to run tauri dev/build, not to keep files healthy.
    const cargo = Bun.which("cargo");
    checks.push({
      name: `${ctx.scaffold.path} rust toolchain`,
      status: cargo !== null ? "pass" : "warn",
      detail: cargo !== null ? `cargo at ${cargo}` : "cargo not found — tauri dev/build won't run",
      ...(cargo !== null
        ? {}
        : {
            fix: "Install Rust via https://rustup.rs (scaffolding and bun install work without it).",
          }),
    });

    // A generator drift tripwire: the frontend entry the template ships.
    const viteConfig = ["vite.config.ts", "vite.config.js"].some((file) =>
      existsSync(join(base, file)),
    );
    checks.push({
      name: `${ctx.scaffold.path} vite config`,
      status: viteConfig ? "pass" : "warn",
      detail: viteConfig ? "vite config present" : "no vite.config.{ts,js} found",
      ...(viteConfig
        ? {}
        : { fix: "Restore the Vite config the create-tauri-app template ships." }),
    });

    return checks;
  },
};
