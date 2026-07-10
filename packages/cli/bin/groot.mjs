#!/usr/bin/env bun
// npm-compatible launcher: npm (≥11) rejects .ts files as bin targets, so this thin
// .mjs shim is the published entrypoint. Bun executes it via the shebang and resolves
// the TypeScript import natively.
//
// If someone runs it with Node (e.g. `npx create-groot` shimmed through node on
// Windows), the guard below prints a friendly pointer instead of a TypeScript
// resolution error — groot's CLI is Bun-only by design (see README).
if (typeof Bun === "undefined") {
  console.error(
    [
      "create-groot requires the Bun runtime (https://bun.sh).",
      "",
      "  bun create groot my-app",
      "",
      "Or install the standalone groot binary (checksum-verified installers):",
      "  https://github.com/bloxy-studios/groot#quick-start",
    ].join("\n"),
  );
  process.exit(1);
}

await import("../src/index.ts");
