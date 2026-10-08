/**
 * Native-only roots (no package.json): Rust, Swift, Flutter/Dart, Python, and
 * Go projects are recognized by their manifests and reported as one native
 * unit at "." with the toolchain they need. Groot never claims writable
 * support for them — discovery stays extensible to these targets while the
 * support level says, precisely, that they are inspect-only.
 */
import type { ProjectUnit } from "../contracts/project.ts";
import { envFindings } from "./env-files.ts";
import type { FactFactory } from "./facts.ts";
import type { ProjectFs } from "./fs.ts";
import type { UnitAnalysis } from "./units.ts";

export interface NativeMarker {
  readonly file: string;
  readonly label: string;
  readonly toolchain: string;
}

export const NATIVE_MARKERS: readonly NativeMarker[] = [
  { file: "Cargo.toml", label: "Rust", toolchain: "cargo" },
  { file: "Package.swift", label: "Swift", toolchain: "xcodebuild" },
  { file: "pubspec.yaml", label: "Flutter/Dart", toolchain: "flutter" },
  { file: "pyproject.toml", label: "Python", toolchain: "python3" },
  { file: "go.mod", label: "Go", toolchain: "go" },
];

/** Native manifests present at the project root. */
export async function nativeMarkers(fs: ProjectFs): Promise<NativeMarker[]> {
  const found: NativeMarker[] = [];
  for (const marker of NATIVE_MARKERS) {
    if (await fs.isFile(marker.file)) found.push(marker);
  }
  return found;
}

/** The single native unit of a native-only root. */
export async function analyzeNativeRoot(
  fs: ProjectFs,
  fact: FactFactory,
  markers: readonly NativeMarker[],
): Promise<UnitAnalysis> {
  const primary = markers[0] as NativeMarker;
  const fingerprint = await fs.hash(primary.file);
  const source = markers.map((marker) => marker.file).join(", ");
  const env = await envFindings(fs, ".");
  const unit: ProjectUnit = {
    id: ".",
    path: ".",
    packageName: null,
    kind: fact({ value: "unknown", source, method: "filesystem", confidence: "low", fingerprint }),
    framework: fact({
      value: null,
      source,
      method: "filesystem",
      confidence: "medium",
      fingerprint,
    }),
    runtime: fact({
      value: "native",
      source,
      method: "filesystem",
      confidence: "high",
      fingerprint,
    }),
    language: "unknown",
    entry: fact({ value: null, source, method: "filesystem", confidence: "low", fingerprint }),
    scripts: {},
    dependencies: {},
    devDependencies: {},
    ports: [],
    envFiles: env.files,
    envVariables: env.variables,
  };
  return {
    unit,
    manifest: null,
    fingerprint,
    toolchains: [...new Set(markers.map((marker) => marker.toolchain))],
    problems: [],
    notes: [
      `native project (${markers.map((marker) => `${marker.label}: ${marker.file}`).join(", ")}) — facts only; Groot does not read native build configuration further`,
    ],
  };
}
