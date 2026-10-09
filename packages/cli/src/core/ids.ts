/**
 * Time-sortable identifiers: `<prefix>_<10-char base36 ms timestamp><12 hex random>`.
 * Lexical order follows creation order, which keeps `.groot/operations/` and
 * evidence listings chronological without an index.
 */
import { randomBytes } from "node:crypto";

export type IdPrefix = "plan" | "op" | "ev" | "task" | "dec" | "rev";

export function newId(prefix: IdPrefix, now: Date = new Date()): string {
  const time = now.getTime().toString(36).padStart(10, "0");
  return `${prefix}_${time}${randomBytes(6).toString("hex")}`;
}

/** Current time as the ISO string every contract uses. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
