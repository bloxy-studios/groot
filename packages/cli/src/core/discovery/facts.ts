/**
 * Fact construction for discovery. Every observed value carries where it came
 * from (source), how (method), how sure discovery is (confidence), when
 * (observedAt — one timestamp per observation), and the fingerprint of the
 * source file when the fact is file-based, so a later edit to that file
 * visibly invalidates the fact.
 */
import type { Confidence, FactMethod, Sha256 } from "../contracts/common.ts";

export interface ObservedFact<T> {
  value: T;
  source: string;
  method: FactMethod;
  confidence: Confidence;
  observedAt: string;
  fingerprint: Sha256 | null;
}

export interface FactInput<T> {
  readonly value: T;
  readonly source: string;
  readonly method: FactMethod;
  readonly confidence: Confidence;
  readonly fingerprint?: Sha256 | null;
}

export type FactFactory = <T>(input: FactInput<T>) => ObservedFact<T>;

/** Two sources that disagree — reported, never merged silently. */
export interface ContradictionNote {
  topic: string;
  explanation: string;
  sources: string[];
}

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  certain: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** A fact factory stamped with one observation time. */
export function factFactory(observedAt: string): FactFactory {
  return <T>(input: FactInput<T>): ObservedFact<T> => ({
    value: input.value,
    source: input.source,
    method: input.method,
    confidence: input.confidence,
    observedAt,
    fingerprint: input.fingerprint ?? null,
  });
}
