/**
 * `groot mcp` — serve groot's core operations as typed MCP tools over stdio
 * (docs/v2-cli-spec.md#groot-mcp). stdout is the protocol channel: the guard
 * is installed first, then the server and core are loaded lazily so other
 * commands never pay the SDK's startup cost.
 */
import { defineCommand } from "citty";
import { guardStdout } from "../core/mcp/guard.ts";

export const mcp = defineCommand({
  meta: { name: "mcp", description: "Serve groot as typed MCP tools over stdio" },
  args: {},
  async run() {
    guardStdout();
    const [{ runMcp }, { createApi }] = await Promise.all([
      import("../core/mcp/server.ts"),
      import("../core/api.ts"),
    ]);
    await runMcp(createApi(), process.cwd());
  },
});
