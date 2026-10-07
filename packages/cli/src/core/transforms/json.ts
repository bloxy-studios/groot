/**
 * Structured JSON edits (RFC 6901 pointers). Applied to parsed content and
 * re-serialized with the file's own indentation and trailing newline; key
 * order of untouched members is preserved, new keys append.
 */
import type { JsonOp } from "../contracts/plan.ts";
import { detectJsonFormat, stringifyWithFormat } from "../json.ts";
import { TransformConflict } from "./errors.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isRecord(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Walk to the parent of the pointer target, creating objects for missing segments. */
function parentOf(
  root: Json,
  tokens: readonly string[],
  create: boolean,
  path: string,
): { parent: Record<string, Json> | Json[]; key: string } | null {
  let node: Json = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(node)) {
      const next: Json | undefined = node[Number(token)];
      if (next === undefined) return null;
      node = next;
      continue;
    }
    if (!isRecord(node)) {
      throw new TransformConflict(path, `"${token}" is not an object`);
    }
    if (node[token] === undefined) {
      if (!create) return null;
      node[token] = {};
    }
    node = node[token] as Json;
  }
  if (!isRecord(node) && !Array.isArray(node)) {
    throw new TransformConflict(path, "the pointer's parent is not a container");
  }
  return { parent: node, key: tokens[tokens.length - 1] as string };
}

function applyOp(root: Json, op: JsonOp, path: string): Json {
  const tokens = parsePointer(op.pointer);
  if (tokens.length === 0) {
    if (op.op === "set") return clone(op.value) as Json;
    throw new TransformConflict(path, `"${op.op}" is not supported on the document root`);
  }
  const located = parentOf(root, tokens, op.op !== "remove", path);
  if (located === null) return root; // remove of a missing member: nothing to do
  const { parent, key } = located;
  const container = parent as Record<string, Json>;
  switch (op.op) {
    case "set":
      container[key] = clone(op.value) as Json;
      return root;
    case "set-if-absent":
      if (container[key] === undefined) container[key] = clone(op.value) as Json;
      return root;
    case "merge": {
      const existing = container[key];
      if (existing !== undefined && !isRecord(existing)) {
        throw new TransformConflict(path, `${op.pointer} exists and is not an object`);
      }
      container[key] = { ...(existing ?? {}), ...(clone(op.value) as Record<string, Json>) };
      return root;
    }
    case "remove":
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete container[key];
      return root;
    case "append-unique": {
      const existing = container[key];
      if (existing === undefined) {
        container[key] = [clone(op.value) as Json];
        return root;
      }
      if (!Array.isArray(existing)) {
        throw new TransformConflict(path, `${op.pointer} exists and is not an array`);
      }
      const serialized = JSON.stringify(op.value);
      if (!existing.some((item) => JSON.stringify(item) === serialized)) {
        existing.push(clone(op.value) as Json);
      }
      return root;
    }
  }
}

/**
 * Apply JSON ops to `current` (null = file absent → start from `{}`).
 * Returns the new file text, formatted like the original.
 */
export function applyJsonEdit(
  current: string | null,
  ops: readonly JsonOp[],
  path: string,
): string {
  let document: Json;
  try {
    document = current === null || current.trim() === "" ? {} : (JSON.parse(current) as Json);
  } catch (error) {
    throw new TransformConflict(
      path,
      `cannot parse as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  for (const op of ops) document = applyOp(document, op, path);
  return stringifyWithFormat(document, detectJsonFormat(current ?? ""));
}
