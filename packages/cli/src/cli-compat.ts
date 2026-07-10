/**
 * bun-create compatibility: `bun create groot my-app` executes this package's bin
 * with a bare destination argument — no `init` subcommand — following the
 * ecosystem's create-* convention (create-next-app, create-hono, …) of treating
 * the first bare word as the target directory. Route those invocations to `init`.
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
