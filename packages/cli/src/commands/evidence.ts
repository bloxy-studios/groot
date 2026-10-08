/**
 * `groot evidence [id]` — list stored evidence (newest first) or show one
 * record with its redacted artifact paths. Evidence is addressable so agents
 * and reviews reference ids instead of pasting logs.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { GLOBAL_ARGS, runV2Command } from "../cli/run.ts";
import { createApi } from "../core/api.ts";
import { listEvidence } from "../core/verify/store.ts";

export const evidence = defineCommand({
  meta: { name: "evidence", description: "List or show verification evidence" },
  args: {
    id: { type: "positional", required: false, description: "Evidence id (ev_…)" },
    ...GLOBAL_ARGS,
  },
  async run({ args }) {
    await runV2Command("evidence", { json: args.json, events: args.events }, async (ctx) => {
      const api = createApi();
      const root = api.projectRoot(ctx.cwd);
      if (args.id !== undefined) {
        const record = await api.getEvidence(root, args.id);
        return {
          ok: true,
          data: record,
          refs: { evidence: [record.id] },
          human: () => {
            console.log(`${pc.bold(record.check)}  ${record.status}  ${pc.dim(record.id)}`);
            console.log(`  ${record.summary}`);
            console.log(
              pc.dim(
                `  ${record.profile} · ${record.startedAt} · ${record.durationMs} ms · ${record.revision.head?.slice(0, 12) ?? "no-git"}${record.revision.dirty ? " (dirty)" : ""}`,
              ),
            );
            if (record.reason !== null) console.log(`  reason: ${record.reason}`);
            if (record.nextStep !== null) console.log(`  ${pc.cyan("next:")} ${record.nextStep}`);
            for (const limitation of record.limitations)
              console.log(pc.dim(`  limitation: ${limitation}`));
            for (const artifact of record.artifacts)
              console.log(`  artifact: ${artifact.path} (${artifact.bytes} bytes)`);
          },
        };
      }
      const records = await listEvidence(root);
      return {
        ok: true,
        data: records.map((record) => ({
          id: record.id,
          check: record.check,
          profile: record.profile,
          status: record.status,
          summary: record.summary,
          finishedAt: record.finishedAt,
        })),
        human: () => {
          if (records.length === 0) console.log("No evidence yet — run `groot verify`.");
          for (const record of records.slice(0, 50)) {
            console.log(
              `${record.status.padEnd(8)} ${record.check.padEnd(36)} ${pc.dim(record.id)}`,
            );
          }
        },
      };
    });
  },
});
