/**
 * TEMPORARY integration placeholder — replaced by the runners/tasks unit
 * merge. Every function reports that tasks are not integrated yet.
 */
import { GrootV2Error } from "../errors.ts";

const missing = (): never => {
  throw new GrootV2Error("GROOT_E_INTERNAL", "agent tasks are not integrated in this build yet");
};

export const createTask = async (..._args: unknown[]): Promise<never> => missing();
export const listTasks = async (..._args: unknown[]): Promise<never> => missing();
export const readTask = async (..._args: unknown[]): Promise<never> => missing();
export const runTask = async (..._args: unknown[]): Promise<never> => missing();
export const reviewTask = async (..._args: unknown[]): Promise<never> => missing();
export const integrateTask = async (..._args: unknown[]): Promise<never> => missing();
