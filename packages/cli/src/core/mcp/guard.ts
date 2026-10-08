/**
 * stdout protection for `groot mcp`: stdout carries only JSON-RPC, so every
 * console method is routed to stderr. Installed by the command BEFORE the
 * MCP server (and anything that might log) is loaded.
 */
import { format } from "node:util";

export function guardStdout(): void {
  const toStderr = (...args: unknown[]): void => {
    try {
      process.stderr.write(`${format(...args)}\n`);
    } catch {
      // stderr closed — nothing safe to do
    }
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.trace = toStderr;
}
