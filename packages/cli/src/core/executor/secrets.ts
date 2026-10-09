/**
 * Secret hygiene for the executor. `env.secret` steps generate values that
 * must never reach the journal, state, logs, output, evidence — or backups.
 *
 * Backups are the subtle case: when a later step edits a file that already
 * holds a secret (an env edit after the secret was generated), its backup
 * would copy the value into `.groot/`. So backups are "concealed": every
 * known secret value is replaced by a placeholder token, and the token's
 * origin (variable name + env file) is recorded in a sidecar. Restoring
 * reveals the value again from the env file it lives in and verifies the
 * result against the journaled before-hash — a value that changed meanwhile
 * yields a conflict, never wrong bytes.
 *
 * Known values = the current values of every variable that must stay secret
 * (knownSecretRefs: this plan's env.secret steps and secret environment
 * contracts, those of every earlier operation, and the blueprint's) — read
 * from their env files, never persisted. Plan documents Groot stores (an
 * operation's plan copy, a saved plan) are concealed the same way, since an
 * exact preview can quote a file a human copied a secret into; their sidecar
 * also records the hash of the original document, so a reveal either
 * reproduces it exactly or fails — it never yields a document nobody planned.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { RelPath, Sha256 } from "../contracts/common.ts";
import type { OperationPlan } from "../contracts/plan.ts";
import { sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { statePaths } from "../state.ts";
import { operationPaths } from "./journal.ts";

/** Values shorter than this are not concealed (too likely to be ordinary text). */
const MIN_CONCEALED_LENGTH = 16;

const TOKEN_PREFIX = "@@groot-secret:";

export interface SecretRef {
  /** Variable name. */
  readonly name: string;
  /** Project-relative env file holding the value. */
  readonly path: string;
}

export interface Placeholder extends SecretRef {
  readonly token: string;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Value of the last `NAME=…` assignment in dotenv text (quotes stripped), or null. */
export function envValue(text: string, name: string): string | null {
  let value: string | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const match = ASSIGNMENT.exec(line);
    if (match?.[1] !== name) continue;
    const raw = (match[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    value = quoted?.[2] ?? raw;
  }
  return value;
}

/** True when dotenv text assigns NAME (any value, possibly empty). */
export function hasEnvAssignment(text: string, name: string): boolean {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => ASSIGNMENT.exec(line)?.[1] === name);
}

function readText(root: string, relPath: string): string | null {
  try {
    return readFileSync(resolveInProject(root, relPath), "utf8");
  } catch {
    return null;
  }
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function entriesOf(value: unknown, key: string): Record<string, unknown>[] {
  const list = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

/**
 * Secret variables a plan-shaped document (a plan, a plan copy, groot.json)
 * declares: env.secret steps, and environment contracts that are secret or
 * randomly generated. Read leniently — a broken document only hides less.
 */
function declaredRefs(document: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  const add = (name: unknown, path: unknown): void => {
    if (typeof name !== "string" || !VARIABLE_NAME.test(name)) return;
    if (typeof path !== "string" || !RelPath.safeParse(path).success) return;
    refs.push({ name, path });
  };
  for (const action of entriesOf(document, "actions")) {
    if (action.type === "env.secret") add(action.name, action.path);
  }
  for (const contract of entriesOf(document, "environment")) {
    if (contract.sensitivity === "secret" || contract.generate === "random-secret") {
      add(contract.name, contract.storage);
    }
  }
  return refs;
}

function readJson(path: () => string): unknown {
  try {
    return JSON.parse(readFileSync(path(), "utf8"));
  } catch {
    return null; // absent, unreadable, or refused (a symlinked state path): nothing to add
  }
}

function operationIdsOf(root: string): string[] {
  try {
    return readdirSync(statePaths.operations(root));
  } catch {
    return [];
  }
}

/**
 * Every variable whose value must stay out of `.groot/` while `plan` runs:
 * its own env.secret steps and secret contracts, those of every earlier
 * operation's plan copy, and the blueprint's secret contracts — a value
 * generated or declared once is concealed (and redacted) in every later
 * operation too, whatever the variable is called.
 */
export function knownSecretRefs(root: string, plan: OperationPlan): SecretRef[] {
  const documents: unknown[] = [plan, readJson(() => resolveInProject(root, "groot.json"))];
  for (const id of operationIdsOf(root)) {
    documents.push(readJson(() => operationPaths(root, id).plan));
  }
  const unique = new Map<string, SecretRef>();
  for (const ref of documents.flatMap(declaredRefs)) unique.set(`${ref.path}\0${ref.name}`, ref);
  return [...unique.values()];
}

/**
 * Values currently held by the plan's secret variables (plus values generated
 * in this process that may not be readable yet). Used for log redaction and
 * backup concealment.
 */
export class SecretBook {
  private readonly generated = new Map<string, SecretRef>();

  constructor(
    private readonly root: string,
    private readonly refs: readonly SecretRef[],
  ) {}

  /** Record a value generated in this process. */
  remember(value: string, ref: SecretRef): void {
    this.generated.set(value, ref);
  }

  /** value → where it lives, from the env files right now plus generated values. */
  current(): Map<string, SecretRef> {
    const values = new Map(this.generated);
    for (const ref of this.refs) {
      const text = readText(this.root, ref.path);
      const value = text === null ? null : envValue(text, ref.name);
      if (value !== null && value.length >= MIN_CONCEALED_LENGTH) values.set(value, ref);
    }
    return values;
  }

  /** Known values, for exact redaction of process output. */
  values(): string[] {
    return [...this.current().keys()];
  }

  /**
   * Replace known secret values in `bytes` with placeholder tokens. Binary
   * content (invalid UTF-8) and content without secrets is returned as-is.
   */
  conceal(bytes: Uint8Array): { bytes: Uint8Array; placeholders: Placeholder[] } {
    const known = this.current();
    if (known.size === 0) return { bytes, placeholders: [] };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { bytes, placeholders: [] };
    }
    if (text.includes(TOKEN_PREFIX)) return { bytes, placeholders: [] };
    const placeholders: Placeholder[] = [];
    for (const [value, ref] of known) {
      if (!text.includes(value)) continue;
      const token = `${TOKEN_PREFIX}${ref.path}:${ref.name}@@`;
      text = text.split(value).join(token);
      placeholders.push({ ...ref, token });
    }
    if (placeholders.length === 0) return { bytes, placeholders };
    return { bytes: Buffer.from(text, "utf8"), placeholders };
  }

  /**
   * Re-insert the values behind `placeholders`, read from their env files
   * now. Returns null when a value is no longer available (the caller then
   * reports a conflict instead of restoring incomplete content).
   */
  reveal(bytes: Uint8Array, placeholders: readonly Placeholder[]): Uint8Array | null {
    if (placeholders.length === 0) return bytes;
    let text = Buffer.from(bytes).toString("utf8");
    for (const placeholder of placeholders) {
      const source = readText(this.root, placeholder.path);
      const value = source === null ? null : envValue(source, placeholder.name);
      if (value === null) return null;
      text = text.split(placeholder.token).join(value);
    }
    return Buffer.from(text, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Concealed documents (plan copies, saved plans)
// ---------------------------------------------------------------------------

const PlaceholderSchema = z.object({ name: z.string(), path: RelPath, token: z.string() }).strict();

/** What a concealed document's sidecar holds (`plan.secrets.json`, `<planId>.secrets.json`). */
export const ConcealedSidecar = z
  .object({
    /** sha256 of the document before concealment: revealing must reproduce it exactly. */
    sha256: Sha256,
    placeholders: z.array(PlaceholderSchema).min(1),
  })
  .strict();
export type ConcealedSidecar = z.infer<typeof ConcealedSidecar>;

export interface ConcealedDocument {
  readonly bytes: Uint8Array;
  /** null: the document quotes no known secret (nothing to conceal, no sidecar). */
  readonly sidecar: ConcealedSidecar | null;
}

/** `text` with every known secret value replaced by a placeholder (see the module comment). */
export function concealDocument(secrets: SecretBook, text: string): ConcealedDocument {
  const original = Buffer.from(text, "utf8");
  const { bytes, placeholders } = secrets.conceal(original);
  if (placeholders.length === 0) return { bytes: original, sidecar: null };
  return { bytes, sidecar: { sha256: sha256Of(original), placeholders } };
}

/**
 * The original bytes of a concealed document, its values read from their env
 * files now — or null when one of them changed or is gone.
 */
export function revealDocument(
  root: string,
  bytes: Uint8Array,
  sidecar: ConcealedSidecar,
): Uint8Array | null {
  const revealed = new SecretBook(root, []).reveal(bytes, sidecar.placeholders);
  return revealed !== null && sha256Of(revealed) === sidecar.sha256 ? revealed : null;
}

/** The variables a sidecar conceals (name + env file), without duplicates. */
export function concealedRefs(sidecar: ConcealedSidecar): SecretRef[] {
  const unique = new Map<string, SecretRef>();
  for (const { name, path } of sidecar.placeholders) unique.set(`${path}\0${name}`, { name, path });
  return [...unique.values()];
}

/** A sidecar file: null when absent, "invalid" when not a plain file, unreadable, or malformed. */
export function readSidecar(path: string): ConcealedSidecar | "invalid" | null {
  let text: string;
  try {
    if (!lstatSync(path).isFile()) return "invalid"; // never through a symlink
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "invalid";
  }
  try {
    const parsed = ConcealedSidecar.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}
