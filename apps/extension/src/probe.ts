import { PORT_SCAN_COUNT, isValidPort, portRange } from "./policy";
import type { ServerInfo } from "./types";

const clip = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

/**
 * Validate and sanitise a server's self-description. It is UNTRUSTED: any local process can answer
 * on a scanned port. Every field is type-checked and clamped, and `port` must equal the port we
 * actually talked to (`expectedPort`), so a responder cannot steer the extension to another port.
 * Returns null when anything is off.
 */
export function parseServerInfo(body: unknown, expectedPort?: number): ServerInfo | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isValidPort(b.port)) return null;
  if (expectedPort !== undefined && b.port !== expectedPort) return null;
  const name = clip(b.name, 64);
  const version = clip(b.version, 32);
  if (!name || version === undefined) return null;
  if (typeof b.startedAt !== "number" || !Number.isFinite(b.startedAt)) return null;
  if (!Number.isInteger(b.protocolVersion)) return null;
  return {
    name,
    version,
    protocolVersion: b.protocolVersion as number,
    pid: Number.isInteger(b.pid) ? (b.pid as number) : 0,
    port: b.port,
    // A claimed start time in the future must not let a server always rank as "newest".
    startedAt: Math.min(Math.max(0, b.startedAt), Date.now()),
    client: clip(b.client, 64) ?? null,
    connected: b.connected === true,
  };
}

/**
 * Ask one port "who are you?" with a plain HTTP GET /info.
 *
 * Why HTTP and not a WebSocket: Chrome delays every new WebSocket connect for several seconds after
 * a few failed ones (anti port-scan throttle), which would stall both discovery and reconnecting.
 * fetch() failures are not throttled, so we only open the WebSocket once a server has answered.
 * Resolves null when nothing (or nothing of ours) answers.
 */
export async function probePort(
  port: number,
  timeoutMs = 600,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerInfo | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/info`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error", // never follow a responder's redirect to some other local service
    });
    if (!res.ok) return null;
    return parseServerInfo(await res.json(), port);
  } catch {
    return null; // refused, timed out, redirected, not JSON, ...
  }
}

/**
 * Is anything speaking HTTP on this port? A WebSocket-only server (the original Browser MCP, or any
 * server without /info) answers a plain GET with 426, which still proves someone is home. Used for an
 * explicitly chosen port so older servers keep working without ever risking a throttled WebSocket.
 */
export async function isListening(
  port: number,
  timeoutMs = 600,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe the whole range in parallel; a refused port answers in about a millisecond. */
export async function scanPorts(
  ports: number[] = portRange(undefined, PORT_SCAN_COUNT),
  timeoutMs = 600,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerInfo[]> {
  const results = await Promise.all(ports.map((p) => probePort(p, timeoutMs, fetchImpl)));
  return results.filter((r): r is ServerInfo => r !== null);
}
