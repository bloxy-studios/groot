/**
 * Canonical serialization of Groot's committed documents. Key order comes
 * from the contract itself (the zod shapes declare fields in their
 * documented order: groot.json is $schema, version, createdWith, conventions,
 * scaffolds, project, apps, capabilities, decisions, environment,
 * verification, context, policy) and is applied recursively, so the same
 * document always produces the same bytes no matter how its objects were
 * built — which keeps plan previews exact and diffs reviewable. Keys the
 * contract doesn't know (groot.json is a loose object for forward
 * compatibility) are preserved after the known ones, in their original order.
 */
import { z } from "zod";
import { BlueprintV2 } from "../contracts/blueprint.ts";
import { GrootLock } from "../contracts/lock.ts";
import { prettyJson } from "../json.ts";

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodNullable || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/** Reorder object keys (recursively) to follow the schema's declared field order. */
export function orderBySchema(value: unknown, schema: z.ZodType): unknown {
  if (value === null || typeof value !== "object") return value;
  const inner = unwrap(schema);
  if (Array.isArray(value)) {
    const element = inner instanceof z.ZodArray ? (inner.element as z.ZodType) : null;
    return value.map((item) => (element === null ? item : orderBySchema(item, element)));
  }
  if (!(inner instanceof z.ZodObject)) return value;
  const shape = inner.shape as Record<string, z.ZodType>;
  const record = value as Record<string, unknown>;
  const known = Object.keys(shape).filter((key) => key in record);
  const extra = Object.keys(record).filter((key) => !(key in shape));
  return Object.fromEntries([
    ...known.map((key) => [key, orderBySchema(record[key], shape[key] as z.ZodType)]),
    ...extra.map((key) => [key, record[key]]),
  ]);
}

/** groot.json v2: contract key order, 2-space indent, trailing newline. */
export function serializeBlueprint(doc: BlueprintV2): string {
  return prettyJson(orderBySchema(doc, BlueprintV2));
}

/** groot.lock.json: contract key order, 2-space indent, trailing newline. */
export function serializeLock(doc: GrootLock): string {
  return prettyJson(orderBySchema(doc, GrootLock));
}
