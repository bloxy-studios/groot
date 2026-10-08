/**
 * stdout protection for `groot mcp`: stdout carries only JSON-RPC, so every
 * console method is routed to stderr — not just log/info/warn: Bun writes
 * console.dir, table, count, group, and its own console.write to stdout too.
 * Counters, timers, and groups keep their usual output, on stderr. Installed
 * by the command BEFORE the MCP server (and anything that might log) is
 * loaded.
 */
import { format, type InspectOptions, inspect } from "node:util";

type ConsoleMethod = (...args: unknown[]) => void;

/** stderr replacements: `line` for plain printers, `special` for stateful or raw ones. */
function stderrConsole(): { line: ConsoleMethod; special: Record<string, ConsoleMethod> } {
  let indent = "";
  const write = (text: string): void => {
    try {
      process.stderr.write(text);
    } catch {
      // stderr closed — nothing safe to do
    }
  };
  const line: ConsoleMethod = (...args) => {
    write(`${format(...args).replace(/^/gm, indent)}\n`);
  };
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const elapsed = (label: string): string => {
    const start = timers.get(label);
    return start === undefined
      ? `Timer "${label}" does not exist`
      : `${label}: ${(performance.now() - start).toFixed(3)}ms`;
  };
  const group: ConsoleMethod = (...label) => {
    if (label.length > 0) line(...label);
    indent += "  ";
  };
  const special: Record<string, ConsoleMethod> = {
    dir: (value, options) => line(inspect(value, options as InspectOptions | undefined)),
    assert: (condition, ...data) => {
      if (!condition) line("Assertion failed", ...data);
    },
    count: (label = "default") => {
      const n = (counts.get(String(label)) ?? 0) + 1;
      counts.set(String(label), n);
      line(`${String(label)}: ${n}`);
    },
    countReset: (label = "default") => counts.delete(String(label)),
    group,
    groupCollapsed: group,
    groupEnd: () => {
      indent = indent.slice(2);
    },
    time: (label = "default") => timers.set(String(label), performance.now()),
    timeLog: (label = "default", ...data) => line(elapsed(String(label)), ...data),
    timeEnd: (label = "default") => {
      line(elapsed(String(label)));
      timers.delete(String(label));
    },
    // Bun's console.write: raw text, no newline.
    write: (...data) => write(data.map(String).join("")),
    // Never send terminal control sequences anywhere near the protocol stream.
    clear: () => {},
  };
  return { line, special };
}

export function guardStdout(): void {
  const { line, special } = stderrConsole();
  const target = console as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    // Console is a constructor (a new console with its own streams), not output.
    if (typeof target[key] !== "function" || key === "Console") continue;
    target[key] = special[key] ?? line;
  }
}
