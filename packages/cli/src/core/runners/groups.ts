/**
 * Runner process groups. Every runner leads its own process group (it runs
 * detached), so whatever it started can be found and stopped as one unit.
 *
 * - While a group is live in this process, Groot must not die without
 *   taking it along: an exit hook kills every live group, and SIGHUP / SIGTERM
 *   handlers do the same before exiting the way the default action would
 *   (128 + signal) — unless the host handles that signal itself (the CLI and
 *   the MCP server abort their work through it, which cancels the runner).
 *   SIGKILL cannot be handled: a runner can still be orphaned that way.
 * - A later Groot finds such an orphan through the group id its predecessor
 *   recorded (`inspectRunnerGroup`): the group counts as the runner only if
 *   its leader is alive and started when the record says — a pid that was
 *   recycled is never mistaken for it.
 */
import { constants } from "node:os";
import { killTree } from "../process.ts";

const isPosix = process.platform !== "win32";
/** A leader whose start time is this close to the recorded spawn is the recorded runner. */
const START_TOLERANCE_MS = 10_000;
const EXIT_SIGNALS: readonly NodeJS.Signals[] = ["SIGHUP", "SIGTERM"];

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killLiveGroups(): void {
  for (const group of liveGroups) killTree(group, "SIGKILL");
}

/**
 * SIGHUP / SIGTERM while runners are live. A host that listens for the
 * signal stays in charge; otherwise the runners die with Groot, which then
 * exits like the default action would have.
 */
function onExitSignal(signal: NodeJS.Signals): void {
  if (process.listeners(signal).some((listener) => listener !== onExitSignal)) return;
  killLiveGroups();
  process.exit(128 + (constants.signals[signal] ?? 0));
}

/** Register a live runner group (see the module comment). */
export function trackGroup(pgid: number): void {
  if (!isPosix) return;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killLiveGroups);
  }
  // Prepended: this handler runs first, while a host's `once` listener is still registered.
  if (liveGroups.size === 0) {
    for (const signal of EXIT_SIGNALS) process.prependListener(signal, onExitSignal);
  }
  liveGroups.add(pgid);
}

/** The group is gone (or was swept): stop guarding it; idle Groot keeps default signal handling. */
export function untrackGroup(pgid: number): void {
  if (!liveGroups.delete(pgid) || liveGroups.size > 0) return;
  for (const signal of EXIT_SIGNALS) process.off(signal, onExitSignal);
}

export function groupAlive(pgid: number): boolean {
  if (!isPosix) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Members of a process group (best effort: pgrep; 1 when only liveness is known). */
export async function groupMembers(pgid: number): Promise<number[]> {
  if (!isPosix || !groupAlive(pgid)) return [];
  try {
    const proc = Bun.spawn(["pgrep", "-g", String(pgid)], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = text
      .split("\n")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    return pids.length > 0 ? pids : groupAlive(pgid) ? [pgid] : [];
  } catch {
    return groupAlive(pgid) ? [pgid] : [];
  }
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await Bun.sleep(50);
  }
  return !groupAlive(pgid);
}

/** Terminate whatever is left in the group; returns [found, leftover]. */
export async function sweepGroup(pgid: number): Promise<[number, number]> {
  if (!isPosix || !groupAlive(pgid)) return [0, 0];
  const found = (await groupMembers(pgid)).length;
  killTree(pgid, "SIGTERM");
  if (!(await waitGroupGone(pgid, 2000))) {
    killTree(pgid, "SIGKILL");
    await waitGroupGone(pgid, 2000);
  }
  return [found, (await groupMembers(pgid)).length];
}

/** `ps -o etime` → seconds (`[[dd-]hh:]mm:ss`), null when unparseable. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0);
}

/** When a live process started (epoch ms, ±1 s), or null when it is gone or unknown. */
async function processStartedAt(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "etime=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const elapsed = parseElapsed(text);
    return elapsed === null ? null : Date.now() - elapsed * 1000;
  } catch {
    return null;
  }
}

/** A runner group as a Groot process recorded it (spawn time in epoch ms). */
export interface RunnerGroupRecord {
  readonly pgid: number;
  readonly startedAt: number;
}

/**
 * What is left of a recorded runner group: `gone` (no such group — or its
 * id now belongs to a process that started at another time), `runner` (the
 * recorded runner is still alive), or `unverified` (the group exists but its
 * leader has exited, so it cannot be told apart from a recycled id).
 */
export async function inspectRunnerGroup(
  record: RunnerGroupRecord,
): Promise<"gone" | "runner" | "unverified"> {
  if (!groupAlive(record.pgid)) return "gone";
  const started = await processStartedAt(record.pgid);
  if (started === null) return groupAlive(record.pgid) ? "unverified" : "gone";
  return Math.abs(started - record.startedAt) <= START_TOLERANCE_MS ? "runner" : "gone";
}

/** Stop a runner group: SIGTERM, then SIGKILL; true once no member is left. */
export async function stopRunnerGroup(pgid: number): Promise<boolean> {
  const [, leftover] = await sweepGroup(pgid);
  return leftover === 0 && !groupAlive(pgid);
}
