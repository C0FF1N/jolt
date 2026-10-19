import { describe, expect, it } from "vitest";

import {
  DEFAULT_PORT,
  PORT_SCAN_COUNT,
  backoffMs,
  friendlyAttachError,
  friendlyClientName,
  isAutomatable,
  isValidPort,
  pickServer,
  portRange,
} from "./policy";
import type { ServerInfo } from "./types";

const srv = (port: number, startedAt: number, client: string | null = null): ServerInfo => ({
  name: "Jolt",
  version: "0",
  protocolVersion: 2,
  pid: port,
  port,
  startedAt,
  client,
  connected: false,
});

describe("backoffMs", () => {
  it("starts quick, grows, and settles at about five seconds", () => {
    const mid = () => 0.5; // no jitter
    expect(backoffMs(0, mid)).toBe(400);
    expect(backoffMs(1, mid)).toBeGreaterThan(backoffMs(0, mid));
    expect(backoffMs(30, mid)).toBe(5000);
  });

  it("jitters within +-15% so windows do not retry in lockstep", () => {
    expect(backoffMs(30, () => 0)).toBe(4250);
    expect(backoffMs(30, () => 1)).toBe(5750);
  });
});

describe("pickServer", () => {
  it("returns nothing when nothing is running", () => {
    expect(pickServer([])).toBeUndefined();
  });

  it("prefers the previously used port while it is still up", () => {
    const found = [srv(9470, 100), srv(9471, 200)];
    expect(pickServer(found, 9470)?.port).toBe(9470);
  });

  it("otherwise takes the newest server (the client the user just started)", () => {
    expect(pickServer([srv(9470, 100), srv(9471, 200)], 9475)?.port).toBe(9471);
  });

  it("breaks a tie with the lowest port", () => {
    expect(pickServer([srv(9472, 100), srv(9470, 100)])?.port).toBe(9470);
  });
});

describe("ports", () => {
  it("scans a contiguous range from the default", () => {
    const r = portRange();
    expect(r).toHaveLength(PORT_SCAN_COUNT);
    expect(r[0]).toBe(DEFAULT_PORT);
    expect(r.at(-1)).toBe(DEFAULT_PORT + PORT_SCAN_COUNT - 1);
  });

  it("validates user ports", () => {
    expect(isValidPort(9470)).toBe(true);
    expect(isValidPort(80)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
    expect(isValidPort(9470.5)).toBe(false);
    expect(isValidPort("9470")).toBe(false);
  });
});

describe("friendlyClientName", () => {
  it.each([
    ["claude-code", "Claude Code"],
    ["Visual Studio Code", "VS Code"],
    ["vscode", "VS Code"],
    ["cursor-vscode", "Cursor"],
    ["windsurf-client", "Windsurf"],
    ["claude-ai", "Claude Desktop"],
    [null, "MCP client"],
    ["", "MCP client"],
    ["my-custom-agent", "my-custom-agent"],
  ])("%s -> %s", (raw, shown) => {
    expect(friendlyClientName(raw)).toBe(shown);
  });

  it("truncates absurdly long names", () => {
    expect(friendlyClientName("x".repeat(100)).length).toBeLessThanOrEqual(28);
  });
});

describe("isAutomatable", () => {
  it("allows normal websites only", () => {
    expect(isAutomatable("https://example.com/a")).toBe(true);
    expect(isAutomatable("http://localhost:3000")).toBe(true);
    for (const bad of [undefined, "", "chrome://settings", "about:blank", "file:///c:/x", "chrome-extension://abc/popup.html", "https://chromewebstore.google.com/detail/x"]) {
      expect(isAutomatable(bad)).toBe(false);
    }
  });
});

describe("friendlyAttachError", () => {
  it("explains the common failures", () => {
    expect(friendlyAttachError("Another debugger is already attached to the tab with id: 7.")).toMatch(/DevTools/);
    expect(friendlyAttachError("Cannot access a chrome:// URL")).toMatch(/normal website tab/);
    expect(friendlyAttachError("No tab with given id 9.")).toMatch(/closed/);
    expect(friendlyAttachError("weird")).toBe("weird");
  });
});
