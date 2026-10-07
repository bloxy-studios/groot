/**
 * Dev-port allocation. Blueprint collisions (two apps declaring the same dev
 * port) are a planning concern; runtime occupancy (something else already
 * listening) is checked separately at verification time, where checks always
 * run on ephemeral ports so they never fight a developer's running servers.
 */
import type { BlueprintV2 } from "./contracts/blueprint.ts";
import type { ProjectObservation } from "./contracts/project.ts";

/** Ports already claimed by the blueprint or observed in the project. */
export function claimedPorts(
  blueprint: BlueprintV2 | null,
  observation: ProjectObservation | null,
): Map<number, string> {
  const claimed = new Map<number, string>();
  for (const app of blueprint?.apps ?? []) {
    if (app.port !== null) claimed.set(app.port, app.path);
  }
  for (const unit of observation?.units ?? []) {
    for (const port of unit.ports) {
      if (!claimed.has(port.value)) claimed.set(port.value, unit.path);
    }
  }
  return claimed;
}

/**
 * The preferred port when unclaimed (user-selected ports win), else the next
 * free one above it. Deterministic for the same inputs.
 */
export function allocatePort(preferred: number, claimed: ReadonlyMap<number, string>): number {
  let port = preferred;
  while (claimed.has(port) && port < 65535) port++;
  return port;
}

/** Blueprint-level collisions: port → apps that declare it (only ports with ≥ 2 owners). */
export function portCollisions(blueprint: BlueprintV2): Map<number, string[]> {
  const owners = new Map<number, string[]>();
  for (const app of blueprint.apps) {
    if (app.port === null) continue;
    owners.set(app.port, [...(owners.get(app.port) ?? []), app.path]);
  }
  return new Map([...owners].filter(([, paths]) => paths.length > 1));
}

/** Is a TCP port free on loopback right now? (runtime occupancy, not blueprint state) */
export function isPortFree(port: number, hostname = "127.0.0.1"): boolean {
  try {
    const server = Bun.listen({ hostname, port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** An OS-assigned free loopback port for a verification run. */
export function ephemeralPort(hostname = "127.0.0.1"): number {
  const server = Bun.listen({ hostname, port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}
