/**
 * The context every core operation receives. Surfaces (CLI commands, the MCP
 * server, task runners) construct it; core functions never print, prompt, or
 * read process globals directly — they emit events and return typed results,
 * which keeps one behavior across every surface.
 */
import pkg from "../../package.json";
import type { EnvironmentInfo } from "./contracts/common.ts";
import type { GrootEvent } from "./contracts/envelope.ts";
import { nowIso } from "./ids.ts";

/** What core code emits; ids, data, and timestamp are optional (filled with null/now). */
export type EventInput = Pick<GrootEvent, "type" | "level" | "message"> &
  Partial<Pick<GrootEvent, "operationId" | "stepId" | "taskId" | "data" | "at">>;

export interface EventSink {
  emit(event: EventInput): void;
}

export interface CoreContext {
  /** Directory the operation was invoked from (projects are discovered from here). */
  readonly cwd: string;
  /** Cancellation (SIGINT/SIGTERM from the CLI, notifications/cancelled from MCP). */
  readonly signal: AbortSignal;
  readonly events: EventSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly grootVersion: string;
}

export const GROOT_VERSION: string = pkg.version;

export function createdWith(): string {
  return `create-groot@${GROOT_VERSION}`;
}

export function environmentInfo(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvironmentInfo {
  return {
    os: process.platform,
    arch: process.arch,
    bun: Bun.version,
    groot: GROOT_VERSION,
    ci: Boolean(env.CI) && env.CI !== "0" && env.CI !== "false",
  };
}

export function toEvent(input: EventInput): GrootEvent {
  return {
    schemaVersion: 1,
    kind: "groot.event",
    type: input.type,
    at: input.at ?? nowIso(),
    level: input.level,
    message: input.message,
    operationId: input.operationId ?? null,
    stepId: input.stepId ?? null,
    taskId: input.taskId ?? null,
    data: input.data ?? null,
  };
}

/** Discards events (tests, quiet library use). */
export const nullSink: EventSink = { emit: () => {} };

/** Collects events in memory (tests, MCP progress batching). */
export function collectingSink(): EventSink & { readonly events: GrootEvent[] } {
  const events: GrootEvent[] = [];
  return {
    events,
    emit(input: EventInput): void {
      events.push(toEvent(input));
    },
  };
}

export function createContext(options: {
  cwd: string;
  signal?: AbortSignal;
  events?: EventSink;
  env?: Readonly<Record<string, string | undefined>>;
}): CoreContext {
  return {
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
    events: options.events ?? nullSink,
    env: options.env ?? process.env,
    grootVersion: GROOT_VERSION,
  };
}
