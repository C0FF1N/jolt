import { execFileSync } from "node:child_process";
import net from "node:net";

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true)); // Port is still in use
    server.once("listening", () => {
      server.close(() => resolve(false)); // Port is free
    });
    server.listen(port);
  });
}

/** PIDs that are LISTENING on `port` (not clients connected to it). */
export function listenerPids(port: number): number[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  if (process.platform === "win32") {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Proto  Local  Foreign  State  PID
      if (cols.length >= 5 && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) {
        pids.add(Number(cols[4]));
      }
    }
    return [...pids].filter((p) => p > 0);
  }
  const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return out.split(/\s+/).filter(Boolean).map(Number).filter((p) => p > 0);
}

/** Opt-in (BROWSERMCP_KILL_PORT_HOLDER=1): terminate whatever is listening on the port. No shell involved. */
export function killProcessOnPort(port: number) {
  try {
    for (const pid of listenerPids(port)) {
      if (pid === process.pid) continue;
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/PID", String(pid)]);
      } else {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch (error) {
    console.error(`Failed to kill process on port ${port}:`, error);
  }
}
