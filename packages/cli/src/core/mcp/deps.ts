/** What every MCP tool module receives. */
import type { EventSink } from "../runtime.ts";
import type { GrootApi } from "./api.ts";
import type { JobTracker } from "./jobs.ts";

export interface ToolDeps {
  readonly api: GrootApi;
  readonly jobs: JobTracker;
  /** Directory `groot mcp` was started in (default project root). */
  readonly cwd: string;
  /** Diagnostics sink — stderr only; stdout is the protocol channel. */
  readonly events: EventSink;
}
