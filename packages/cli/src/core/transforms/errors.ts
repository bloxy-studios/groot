/**
 * A transform that cannot establish a safe match (unparseable file, missing
 * or ambiguous anchor, human-edited managed region). Planners turn it into a
 * GROOT_E_CONFLICT with the path and reason; nothing is guessed or overwritten.
 */
export class TransformConflict extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "TransformConflict";
    this.path = path;
    this.reason = reason;
  }
}
