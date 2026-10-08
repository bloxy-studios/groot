/**
 * Registry of internal handlers: vetted engine stages (e.g. the v1 stitch)
 * that a plan can invoke as one journaled `internal` step by name. Plans name
 * handlers; they never carry code.
 */
import type { InternalHandler } from "./types.ts";

const internalHandlers = new Map<string, InternalHandler>();

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  internalHandlers.set(name, handler);
}

export function internalHandler(name: string): InternalHandler | undefined {
  return internalHandlers.get(name);
}
