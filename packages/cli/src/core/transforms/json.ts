/**
 * Structured JSON edits (RFC 6901 pointers). Applied to parsed content and
 * re-serialized with the file's own indentation, line endings, and trailing
 * newline; key order of untouched members is preserved, new keys append.
 *
 * Pointers address JSON members only: tokens that would reach the prototype
 * chain (`__proto__`, `constructor`, `prototype`) are conflicts, descent
 * follows own members, and members are created as own data properties — so
 * an untrusted plan can never modify Object.prototype through an edit.
 */
import type { JsonOp } from "../contracts/plan.ts";
import { detectJsonFormat, stringifyWithFormat } from "../json.ts";
import { TransformConflict } from "./errors.ts";
import { preservingLineEndings } from "./regions.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Container = Record<string, Json> | Json[];

/** Pointer tokens that name prototype machinery rather than a JSON member. */
const UNSAFE_TOKENS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function parsePointer(pointer: string, path: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer "${pointer}"`);
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const unsafe = tokens.find((token) => UNSAFE_TOKENS.has(token));
  if (unsafe !== undefined) {
    throw new TransformConflict(
      path,
      `the JSON pointer ${pointer} addresses "${unsafe}", which groot never edits`,
    );
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The container's own member (inherited properties are not JSON members). */
function member(container: Container, key: string): Json | undefined {
  return Object.hasOwn(container, key) ? (container as Record<string, Json>)[key] : undefined;
}

/** Create or replace an own member; defining it never reaches an inherited setter. */
function setMember(container: Container, key: string, value: Json): void {
  if (Array.isArray(container)) {
    (container as unknown as Record<string, Json>)[key] = value;
    return;
  }
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Walk to the parent of the pointer target, creating objects for missing segments. */
function parentOf(
  root: Json,
  tokens: readonly string[],
  create: boolean,
  path: string,
): { parent: Container; key: string } | null {
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
    let next = member(node, token);
    if (next === undefined) {
      if (!create) return null;
      next = {};
      setMember(node, token, next);
    }
    node = next;
  }
  if (!isRecord(node) && !Array.isArray(node)) {
    throw new TransformConflict(path, "the pointer's parent is not a container");
  }
  return { parent: node, key: tokens[tokens.length - 1] as string };
}

function applyOp(root: Json, op: JsonOp, path: string): Json {
  const tokens = parsePointer(op.pointer, path);
  if (tokens.length === 0) {
    if (op.op === "set") return clone(op.value) as Json;
    throw new TransformConflict(path, `"${op.op}" is not supported on the document root`);
  }
  const located = parentOf(root, tokens, op.op !== "remove", path);
  if (located === null) return root; // remove of a missing member: nothing to do
  const { parent, key } = located;
  switch (op.op) {
    case "set":
      setMember(parent, key, clone(op.value) as Json);
      return root;
    case "set-if-absent":
      if (member(parent, key) === undefined) setMember(parent, key, clone(op.value) as Json);
      return root;
    case "merge": {
      const existing = member(parent, key);
      if (existing !== undefined && !isRecord(existing)) {
        throw new TransformConflict(path, `${op.pointer} exists and is not an object`);
      }
      setMember(parent, key, {
        ...(existing ?? {}),
        ...(clone(op.value) as Record<string, Json>),
      });
      return root;
    }
    case "remove":
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else if (Object.hasOwn(parent, key)) delete parent[key];
      return root;
    case "append-unique": {
      const existing = member(parent, key);
      if (existing === undefined) {
        setMember(parent, key, [clone(op.value) as Json]);
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
 * Returns the new file text, formatted like the original (`current` itself
 * when the text would not change).
 */
export function applyJsonEdit(
  current: string | null,
  ops: readonly JsonOp[],
  path: string,
): string {
  return preservingLineEndings(current, (text) => {
    let document: Json;
    try {
      document = text.trim() === "" ? {} : (JSON.parse(text) as Json);
    } catch (error) {
      throw new TransformConflict(
        path,
        `cannot parse as JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    for (const op of ops) document = applyOp(document, op, path);
    return stringifyWithFormat(document, detectJsonFormat(text));
  });
}
