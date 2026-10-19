import { describe, expect, it } from "vitest";

import type { ServerInfo, Status } from "./types";
import { clientRows, describe as view } from "./view-model";

const NOW = 1_000_000;
const site = { id: 5, url: "https://example.com/" };
const base: Status = { state: "idle", port: 9470, pinned: false };
const server = (port: number, client: string | null, connected = false): ServerInfo => ({
  name: "Jolt",
  version: "0",
  protocolVersion: 2,
  pid: 1,
  port,
  startedAt: 1,
  client,
  connected,
});

const v = (status: Partial<Status>, servers: ServerInfo[] = [], tab: typeof site | { id: number; url: string } = site) =>
  view({ status: { ...base, ...status }, servers, activeTab: tab, now: NOW });

describe("idle", () => {
  it("invites you to start a client when none is running, and still lets you arm the tab", () => {
    const x = v({});
    expect(x.title).toBe("No MCP client yet");
    expect(x.primary).toEqual({ action: "connect", label: "Connect and wait", disabled: false });
  });

  it("names the one client it found", () => {
    const x = v({}, [server(9470, "claude-code")]);
    expect(x.sub).toContain("Claude Code");
    expect(x.primary.label).toBe("Connect this tab");
  });

  it("asks you to choose when several are running", () => {
    expect(v({}, [server(9470, "claude-code"), server(9471, "vscode")]).sub).toMatch(/2 clients found/);
  });

  it("disables connecting on pages Chrome will not let us debug", () => {
    const x = v({}, [], { id: 1, url: "chrome://settings" });
    expect(x.primary.disabled).toBe(true);
    expect(x.title).toBe("Open a website tab");
  });
});

describe("connected", () => {
  const live: Partial<Status> = { state: "connected", tabId: 5, port: 9470, rttMs: 1.2, server: server(9470, "claude-code") };

  it("shows who is driving and the latency", () => {
    const x = v(live);
    expect(x).toMatchObject({ tone: "ok", title: "Connected", showRtt: true });
    expect(x.sub).toBe("Claude Code · :9470");
    expect(x.primary.action).toBe("disconnect");
  });

  it("offers to move the link when another tab is active", () => {
    const x = v(live, [], { id: 9, url: "https://other.example/" });
    expect(x.title).toBe("Connected to another tab");
    expect(x.primary).toMatchObject({ action: "switch", label: "Move to this tab" });
  });

  it("falls back to disconnect when the active tab cannot be automated", () => {
    expect(v(live, [], { id: 9, url: "chrome://extensions" }).primary.action).toBe("disconnect");
  });
});

describe("waiting", () => {
  it("counts down to the next try; Retry now is the main action and Stop is the quiet one", () => {
    const x = v({ state: "waiting", server: server(9470, "claude-code"), nextRetryAt: NOW + 2400, attempt: 3 });
    expect(x.tone).toBe("warn");
    expect(x.title).toBe("Reconnecting…");
    expect(x.sub).toBe("Lost Claude Code. Next try in 3s");
    expect(x.primary).toMatchObject({ action: "retry", label: "Retry now" });
    expect(x.secondary).toMatchObject({ action: "disconnect", label: "Stop" });
  });

  it("says it is waiting for a first client when it never linked", () => {
    const x = v({ state: "waiting" });
    expect(x.title).toBe("Waiting for an MCP client");
    expect(x.sub).toMatch(/joins automatically/);
  });

  it("mentions the fixed port when one was chosen", () => {
    expect(v({ state: "waiting", pinned: true, port: 9475, nextRetryAt: NOW }).sub).toBe("Nothing on :9475 yet. Trying now");
  });
});

describe("connecting and error", () => {
  it("blocks the button while connecting", () => {
    expect(v({ state: "connecting" }).primary).toMatchObject({ action: "none", disabled: true });
  });

  it("shows the error and lets you try again", () => {
    const x = v({ state: "error", error: "Chrome doesn't allow automation on this page." });
    expect(x).toMatchObject({ tone: "error", title: "Couldn't connect" });
    expect(x.sub).toMatch(/doesn't allow/);
    expect(x.primary).toMatchObject({ action: "connect", label: "Try again", disabled: false });
  });
});

describe("clientRows", () => {
  it("lists servers by port, marking the selection, the live link and busy servers", () => {
    const rows = clientRows(
      [server(9472, "vscode", true), server(9470, "claude-code", true)],
      { ...base, state: "connected", port: 9470 },
      9472,
    );
    expect(rows.map((r) => r.port)).toEqual([9470, 9472]);
    expect(rows[0]).toMatchObject({ name: "Claude Code", current: true, selected: false, meta: ":9470" });
    expect(rows[1]).toMatchObject({ name: "VS Code", current: false, selected: true, meta: ":9472 · has a tab" });
  });
});
