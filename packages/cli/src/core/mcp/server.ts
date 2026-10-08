/**
 * `groot mcp` — typed MCP tools over stdio, calling the same core API and
 * policy as the CLI. Built on @modelcontextprotocol/server 2.x, whose
 * `serveStdio` speaks both protocol eras (2026-07-28 for Claude Code, the
 * 2025-06-18 handshake for Codex) from one factory; a fresh McpServer is
 * built per connection.
 *
 * stdout is the protocol channel. `guardStdout()` must run before anything
 * else loads so stray console output can never corrupt the stream.
 */
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { EventSink } from "../runtime.ts";
import { GROOT_VERSION, toEvent } from "../runtime.ts";
import type { GrootApi } from "./api.ts";
import type { ToolDeps } from "./deps.ts";
import { JobTracker } from "./jobs.ts";
import { registerOperationTools } from "./tools-operations.ts";
import { registerProjectTools } from "./tools-project.ts";
import { registerTaskTools } from "./tools-tasks.ts";

/** Instructions shown to clients (first 512 chars stand alone for Codex; < 2 KiB for Claude Code). */
export const INSTRUCTIONS =
  "groot keeps this project's blueprint, plans, operations, and verification evidence. Loop: project_inspect or context_get → plan_add (a preview; nothing changes) → operation_apply → operation_status → verify_run. Errors start with a GROOT_E_* code and say what to do next. Never edit groot.json or groot.lock.json by hand; secrets are never returned — only variable names. Ask the user before approving extra action classes, applying plans that edit their files, approving task reviews, or rolling back.";

/** Route every console method to stderr (stdout carries only JSON-RPC). */
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

/** JSON-lines diagnostics on stderr, filtered by GROOT_LOG_LEVEL (default warn). */
export function stderrEvents(level = process.env.GROOT_LOG_LEVEL ?? "warn"): EventSink {
  const order = ["debug", "info", "warn", "error"];
  const threshold = Math.max(0, order.indexOf(level));
  return {
    emit(input): void {
      if (order.indexOf(input.level) < threshold) return;
      try {
        process.stderr.write(`${JSON.stringify(toEvent(input))}\n`);
      } catch {
        // ignore
      }
    },
  };
}

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "groot", version: GROOT_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerProjectTools(server, deps);
  registerOperationTools(server, deps);
  registerTaskTools(server, deps);
  return server;
}

/** Serve until stdin closes or the process is signalled; in-flight jobs are aborted at checkpoints. */
export async function runMcp(api: GrootApi, cwd: string = process.cwd()): Promise<void> {
  guardStdout();
  const jobs = new JobTracker();
  const deps: ToolDeps = { api, jobs, cwd, events: stderrEvents() };
  const handle = serveStdio(() => buildServer(deps));
  const shutdown = (signal: string): void => {
    jobs.abortAll(`groot mcp received ${signal}`);
    void handle.close();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
