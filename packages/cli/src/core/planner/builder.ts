/**
 * PlanBuilder — the one way planners assemble an OperationPlan. It assigns
 * step ids, derives preconditions from each action's expectations (so a
 * human edit to any touched file makes the plan stale), computes exact
 * previews for edits whose content is known at planning time (never for
 * secret-bearing dotenv edits), collects dependency changes and required
 * action classes, and fingerprints the result.
 */
import { readFile } from "node:fs/promises";
import type { RecoveryInfo, SolverResult } from "../contracts/capability.ts";
import type {
  ActionClass,
  EnvVarContract,
  RevisionInfo,
  Topology,
  VerificationContract,
} from "../contracts/common.ts";
import { schemaUrl } from "../contracts/common.ts";
import type { GeneratorLock } from "../contracts/lock.ts";
import {
  type DependencyChange,
  type ExternalAction,
  isSecretBearingEdit,
  type OperationPlan,
  type OwnershipRule,
  type PathExpectation,
  type PlanIntent,
  type PlannedAction,
  type Precondition,
  type StructuredEdit,
} from "../contracts/plan.ts";
import { GrootV2Error } from "../errors.ts";
import { hashFile, sha256Of } from "../fs/hash.ts";
import { resolveInProject } from "../fs/paths.ts";
import { newId, nowIso } from "../ids.ts";
import { canonicalJson } from "../json.ts";
import { applyEdit, TransformConflict } from "../transforms/index.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ActionDraft = DistributiveOmit<PlannedAction, "id">;

export interface PlanBuilderInit {
  readonly root: string;
  readonly intent: PlanIntent;
  readonly summary: string;
  readonly topology: Topology;
  readonly revision: RevisionInfo;
  readonly createdWith: string;
  /** Paths with uncommitted changes (from git state) — flagged, never clobbered. */
  readonly dirtyPaths?: ReadonlySet<string>;
}

const EMPTY_SOLVER: SolverResult = { ok: true, selections: [], refusals: [] };

export class PlanBuilder {
  private readonly init: PlanBuilderInit;
  private readonly actions: PlannedAction[] = [];
  private readonly preconditions = new Map<string, Precondition>();
  private readonly generators: GeneratorLock[] = [];
  private readonly environment = new Map<string, EnvVarContract>();
  private readonly verification = new Map<string, VerificationContract>();
  private readonly ownership: OwnershipRule[] = [];
  private readonly assumptions: string[] = [];
  /** Paths each step produces — later steps expect them as `produced`. */
  private readonly produced = new Map<string, string>();
  private solver: SolverResult = EMPTY_SOLVER;
  private recovery: RecoveryInfo = {
    mode: "full",
    summary: "Every step restores from journaled backups when its files are unchanged since apply.",
    irreversible: [],
    limits: [],
  };

  /** Allocated up front so recipes can reference the plan in blueprint/lock content. */
  readonly planId: string = newId("plan");
  readonly createdAt: string = nowIso();

  constructor(init: PlanBuilderInit) {
    this.init = init;
  }

  get root(): string {
    return this.init.root;
  }

  /** Expectation for a path given what earlier steps produce. */
  async expectationFor(path: string): Promise<PathExpectation> {
    const producer = this.produced.get(path);
    if (producer !== undefined) return { state: "produced", byStep: producer };
    const hash = await hashFile(resolveInProject(this.init.root, path));
    return hash === null ? { state: "absent" } : { state: "sha256", sha256: hash };
  }

  /**
   * Content of a path as later steps will see it (null = absent). For a path
   * an earlier step changes without a preview (see contentKnown) this is the
   * last content known at planning time; editFile defers edits of such paths
   * instead of previewing them.
   */
  async currentContent(path: string): Promise<string | null> {
    const pending = this.pendingContent.get(path);
    if (pending !== undefined) return pending;
    try {
      return await readFile(resolveInProject(this.init.root, path), "utf8");
    } catch {
      return null;
    }
  }

  private readonly pendingContent = new Map<string, string>();

  /**
   * Is the content a path will have before the next step known now? Yes for
   * files on disk (or absent), and for the exact result of an earlier write
   * or previewed edit. No when an earlier step changes the path without a
   * preview — deps.add, a deferred or secret-bearing edit, a move, a
   * generator — so an edit of it is deferred to the executor.
   */
  private contentKnown(expect: PathExpectation): boolean {
    if (expect.state !== "produced") return true;
    const producer = this.actions.find((action) => action.id === expect.byStep);
    return (
      producer?.type === "file.write" || (producer?.type === "file.edit" && producer.after !== null)
    );
  }

  add(draft: ActionDraft): string {
    const id = `s${String(this.actions.length + 1).padStart(2, "0")}`;
    const action = { ...draft, id } as PlannedAction;
    this.actions.push(action);
    this.trackExpectations(action);
    return id;
  }

  private trackExpectations(action: PlannedAction): void {
    const record = (path: string, expect: PathExpectation): void => {
      if (expect.state !== "produced" && !this.preconditions.has(`path:${path}`)) {
        this.preconditions.set(`path:${path}`, {
          type: "path",
          path,
          expect,
          dirty: this.init.dirtyPaths?.has(path) ?? false,
        });
      }
    };
    switch (action.type) {
      case "file.write":
        record(action.path, action.expect);
        this.produced.set(action.path, action.id);
        this.pendingContent.set(action.path, action.content);
        break;
      case "file.edit":
        record(action.path, action.expect);
        this.produced.set(action.path, action.id);
        if (action.after !== null) this.pendingContent.set(action.path, action.after.content);
        break;
      case "file.delete":
        record(action.path, action.expect);
        this.produced.delete(action.path);
        this.pendingContent.delete(action.path);
        break;
      case "file.move":
        record(action.from, action.expect);
        this.produced.set(action.to, action.id);
        break;
      case "deps.add": {
        const pkgPath = action.unit === "." ? "package.json" : `${action.unit}/package.json`;
        record(pkgPath, action.expect);
        this.produced.set(pkgPath, action.id);
        break;
      }
      case "generator.run":
        this.produced.set(action.produces, action.id);
        break;
      default:
        break;
    }
  }

  /**
   * Plan a full-file write with an exact preview. Returns null (no step) when
   * the file already has exactly this content — re-planning a satisfied write
   * is a no-op. A different existing file is a conflict unless `replaceSha`
   * names the hash Groot is allowed to replace (an owned file).
   */
  async writeFile(options: {
    path: string;
    content: string;
    description: string;
    ownership?: "file" | "none";
    executable?: boolean;
    replaceSha?: string | null;
    compensation?: string;
  }): Promise<string | null> {
    const expect = await this.expectationFor(options.path);
    const sha = sha256Of(options.content);
    if (expect.state === "sha256") {
      if (expect.sha256 === sha) return null;
      if (options.replaceSha !== expect.sha256) {
        throw new GrootV2Error(
          "GROOT_E_CONFLICT",
          `${options.path} already exists with different content.`,
          {
            hint: "Groot never overwrites files it doesn't own. Move or rename the existing file, or choose a different target.",
            details: { path: options.path, conflict: "file-exists" },
          },
        );
      }
    }
    return this.add({
      type: "file.write",
      path: options.path,
      content: options.content,
      sha256: sha,
      expect,
      ownership: options.ownership ?? "file",
      executable: options.executable ?? false,
      description: options.description,
      classes: expect.state === "absent" ? ["fs.create"] : ["fs.edit"],
      reversible: true,
      compensation:
        options.compensation ??
        (expect.state === "absent"
          ? `delete ${options.path} if unchanged since apply`
          : `restore the previous ${options.path} from backup if unchanged since apply`),
    });
  }

  /**
   * Plan a structured edit with an exact preview when the file's content is
   * known now (existing, or produced by an earlier step with known content);
   * otherwise the edit is deferred and the executor computes it at apply
   * time. Secret-bearing edits (env edits, non-example dotenv files) are
   * still computed here — for conflicts and the no-op skip — but never carry
   * their result: `expect` pins the content they apply to and the edit itself
   * (variable names) is their preview. Returns null when the edit is already
   * applied. Transform conflicts become GROOT_E_CONFLICT with the precise reason.
   */
  async editFile(options: {
    path: string;
    edit: StructuredEdit;
    description: string;
    owns: string[];
    createIfMissing: boolean;
    deferred?: boolean;
  }): Promise<string | null> {
    const expect = await this.expectationFor(options.path);
    const current = await this.currentContent(options.path);
    if (current === null && !options.createIfMissing && expect.state !== "produced") {
      throw new GrootV2Error("GROOT_E_CONFLICT", `${options.path} does not exist.`, {
        details: { path: options.path, conflict: "missing-file" },
      });
    }
    let after: { content: string; sha256: ReturnType<typeof sha256Of> } | null = null;
    if (!options.deferred && this.contentKnown(expect)) {
      let content: string;
      try {
        content = applyEdit(current, options.edit, options.path);
      } catch (error) {
        if (error instanceof TransformConflict) {
          throw new GrootV2Error("GROOT_E_CONFLICT", error.message, {
            hint: "Resolve the conflict in that file (or choose a different target), then plan again.",
            details: { path: error.path, conflict: "transform", reason: error.reason },
          });
        }
        throw error;
      }
      if (current !== null && content === current) return null;
      if (!isSecretBearingEdit(options.path, options.edit)) {
        after = { content, sha256: sha256Of(content) };
      }
    }
    const classes: ActionClass[] = expect.state === "absent" ? ["fs.create"] : ["fs.edit"];
    return this.add({
      type: "file.edit",
      path: options.path,
      edit: options.edit,
      expect,
      after,
      owns: options.owns,
      createIfMissing: options.createIfMissing,
      description: options.description,
      classes,
      reversible: true,
      compensation:
        expect.state === "absent"
          ? `delete ${options.path} if unchanged since apply`
          : `restore the previous ${options.path} from backup if unchanged since apply`,
    });
  }

  precondition(precondition: Precondition): void {
    const key =
      precondition.type === "path"
        ? `path:${precondition.path}`
        : precondition.type === "toolchain"
          ? `toolchain:${precondition.id}`
          : precondition.type === "fresh-dir"
            ? `fresh:${precondition.path}`
            : "manifest";
    if (!this.preconditions.has(key)) this.preconditions.set(key, precondition);
  }

  generator(lock: GeneratorLock): void {
    this.generators.push(lock);
  }

  env(contract: EnvVarContract): void {
    this.environment.set(`${contract.consumer}:${contract.name}`, contract);
  }

  verify(contract: VerificationContract): void {
    this.verification.set(contract.id, contract);
  }

  own(rule: OwnershipRule): void {
    this.ownership.push(rule);
  }

  assume(text: string): void {
    if (!this.assumptions.includes(text)) this.assumptions.push(text);
  }

  capabilities(result: SolverResult): void {
    this.solver = result;
  }

  setRecovery(info: RecoveryInfo): void {
    this.recovery = info;
  }

  get stepCount(): number {
    return this.actions.length;
  }

  build(): OperationPlan {
    const preconditions = [...this.preconditions.values()];
    const requiredClasses = [...new Set(this.actions.flatMap((action) => action.classes))].sort();
    const dependencies: DependencyChange[] = this.actions.flatMap((action) =>
      action.type === "deps.add" ? action.changes : [],
    );
    const external = this.actions.filter(
      (action): action is ExternalAction => action.type === "external",
    );
    const irreversible = this.actions
      .filter((action) => !action.reversible)
      .map((action) => `${action.id}: ${action.description} — ${action.compensation}`);
    const recovery: RecoveryInfo = {
      ...this.recovery,
      mode: irreversible.length === 0 ? this.recovery.mode : "partial",
      irreversible: [...new Set([...this.recovery.irreversible, ...irreversible])],
    };
    const fingerprint = sha256Of(
      canonicalJson({ intent: this.init.intent, actions: this.actions, preconditions }),
    );
    return {
      $schema: schemaUrl("plan"),
      schemaVersion: 1,
      kind: "groot.plan",
      planId: this.planId,
      createdAt: this.createdAt,
      createdWith: this.init.createdWith,
      intent: this.init.intent,
      summary: this.init.summary,
      project: {
        root: this.init.root,
        topology: this.init.topology,
        revision: this.init.revision,
      },
      capabilities: this.solver,
      generators: this.generators,
      actions: this.actions,
      dependencies,
      environment: [...this.environment.values()],
      external,
      preconditions,
      ownership: this.ownership,
      requiredClasses,
      verification: [...this.verification.values()],
      recovery,
      assumptions: this.assumptions,
      fingerprint,
    };
  }
}
