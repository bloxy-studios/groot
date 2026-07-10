/**
 * bun-create compatibility: `bun create groot my-app` executes this package's bin
 * with a bare destination argument — no `init` subcommand — exactly like
 * `npx create-next-app my-app` conventions. Route those invocations to `init`.
 */

const KNOWN_COMMANDS = new Set(["init", "add", "doctor"]);

/**
 * Rewrite raw CLI args so a leading bare word that isn't a known subcommand is
 * treated as `init <dir>`. Flags-only and known-subcommand invocations pass
 * through untouched.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  const first = argv[0];
  if (first === undefined || first.startsWith("-") || KNOWN_COMMANDS.has(first)) {
    return [...argv];
  }
  return ["init", ...argv];
}
