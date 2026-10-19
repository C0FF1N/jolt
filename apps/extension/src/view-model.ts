import { friendlyClientName, isAutomatable } from "./policy";
import type { ServerInfo, Status } from "./types";

/** Everything the popup shows is derived here, so it can be tested without a DOM. */

export type Tone = "idle" | "busy" | "ok" | "warn" | "error";
export type PrimaryAction = "connect" | "disconnect" | "switch" | "retry" | "none";
export type Button = { action: PrimaryAction; label: string; disabled: boolean };

export type View = {
  tone: Tone;
  title: string;
  sub: string;
  primary: Button;
  /** Quieter second button next to the primary one. */
  secondary?: Button;
  showRtt: boolean;
  /** Small note under the buttons (why something is disabled). */
  hint?: string;
};

export type ViewInput = {
  status: Status;
  servers: ServerInfo[];
  activeTab?: { id?: number; url?: string };
  /** Epoch ms; injected so countdowns are deterministic in tests. */
  now: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describe({ status, servers, activeTab, now }: ViewInput): View {
  const here = status.tabId !== undefined && status.tabId === activeTab?.id;
  const canAutomate = isAutomatable(activeTab?.url);
  const client = status.server ? friendlyClientName(status.server.client) : undefined;
  const blockedHint = canAutomate ? undefined : "Chrome blocks automation on this page. Switch to a website tab.";

  switch (status.state) {
    case "connected":
      return {
        tone: "ok",
        title: here ? "Connected" : "Connected to another tab",
        sub: `${client ?? "MCP client"} · :${status.port}`,
        primary: here
          ? { action: "disconnect", label: "Disconnect", disabled: false }
          : canAutomate
            ? { action: "switch", label: "Move to this tab", disabled: false }
            : { action: "disconnect", label: "Disconnect", disabled: false },
        showRtt: status.rttMs !== undefined,
        hint: here || canAutomate ? undefined : blockedHint,
      };

    case "connecting":
      return {
        tone: "busy",
        title: "Connecting…",
        sub: "Looking for an MCP client",
        primary: { action: "none", label: "Connecting…", disabled: true },
        showRtt: false,
      };

    case "waiting": {
      const secs =
        status.nextRetryAt === undefined ? undefined : Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000));
      const next = secs === undefined ? "" : secs === 0 ? "Trying now" : `Next try in ${secs}s`;
      const everLinked = status.server !== undefined;
      return {
        tone: "warn",
        title: everLinked ? "Reconnecting…" : "Waiting for an MCP client",
        sub: everLinked
          ? `Lost ${client}. ${next}`.trim()
          : status.pinned
            ? `Nothing on :${status.port} yet. ${next}`.trim()
            : "Start Claude Code or VS Code; this tab joins automatically.",
        primary: { action: "retry", label: "Retry now", disabled: false },
        secondary: { action: "disconnect", label: "Stop", disabled: false },
        showRtt: false,
      };
    }

    case "error":
      return {
        tone: "error",
        title: "Couldn't connect",
        sub: status.error ?? "Something went wrong.",
        primary: { action: "connect", label: "Try again", disabled: !canAutomate },
        showRtt: false,
        hint: blockedHint,
      };

    default: {
      if (!canAutomate) {
        return {
          tone: "idle",
          title: "Open a website tab",
          sub: "Chrome doesn't allow automation on this page.",
          primary: { action: "connect", label: "Connect this tab", disabled: true },
          showRtt: false,
        };
      }
      const n = servers.length;
      return {
        tone: "idle",
        title: n > 0 ? "Ready to connect" : "No MCP client yet",
        sub:
          n === 0
            ? "Start Claude Code or VS Code. Connect now and this tab joins when one starts."
            : n === 1
              ? `Found ${friendlyClientName(servers[0].client)}. Connect this tab to let it drive.`
              : `${plural(n, "client")} found. Pick one below.`,
        primary: { action: "connect", label: n > 0 ? "Connect this tab" : "Connect and wait", disabled: false },
        showRtt: false,
      };
    }
  }
}

export type ClientRow = {
  port: number;
  name: string;
  meta: string;
  selected: boolean;
  /** This is the server the tab is linked to right now. */
  current: boolean;
};

export function clientRows(servers: ServerInfo[], status: Status, selectedPort: number | undefined): ClientRow[] {
  return [...servers]
    .sort((a, b) => a.port - b.port)
    .map((s) => {
      const current = status.state === "connected" && status.port === s.port;
      const takenElsewhere = s.connected && !current;
      return {
        port: s.port,
        name: friendlyClientName(s.client),
        meta: takenElsewhere ? `:${s.port} · has a tab` : `:${s.port}`,
        selected: s.port === selectedPort,
        current,
      };
    });
}
