import { describe, expect, it } from "vitest";

import { parseServerInfo } from "./probe";

const good = {
  name: "Jolt",
  version: "0.2.0",
  protocolVersion: 2,
  pid: 4242,
  port: 9471,
  startedAt: 1_000,
  client: "claude-code",
  connected: true,
};

describe("parseServerInfo (server answers are untrusted)", () => {
  it("accepts a well-formed description", () => {
    expect(parseServerInfo(good, 9471)).toEqual(good);
  });

  it("rejects a responder that points at a different port than the one probed", () => {
    expect(parseServerInfo({ ...good, port: 9475 }, 9471)).toBeNull();
  });

  it.each([
    ["not an object", "x"],
    ["null", null],
    ["fractional port", { ...good, port: 9471.5 }],
    ["port out of range", { ...good, port: 70000 }],
    ["privileged port", { ...good, port: 80 }],
    ["missing name", { ...good, name: "" }],
    ["non-string name", { ...good, name: 5 }],
    ["non-string version", { ...good, version: {} }],
    ["non-numeric startedAt", { ...good, startedAt: "now" }],
    ["NaN startedAt", { ...good, startedAt: Number.NaN }],
    ["fractional protocolVersion", { ...good, protocolVersion: 2.5 }],
  ])("rejects %s", (_label, body) => {
    expect(parseServerInfo(body)).toBeNull();
  });

  it("neutralises hostile optional fields instead of trusting them", () => {
    const x = parseServerInfo({ ...good, client: { toString: "boom" }, pid: "1", connected: "yes" }, 9471)!;
    expect(x.client).toBeNull(); // would have crashed .trim() in the popup
    expect(x.pid).toBe(0);
    expect(x.connected).toBe(false);
  });

  it("truncates absurdly long strings", () => {
    const x = parseServerInfo({ ...good, name: "n".repeat(500), client: "c".repeat(500), version: "v".repeat(500) })!;
    expect(x.name).toHaveLength(64);
    expect(x.client).toHaveLength(64);
    expect(x.version).toHaveLength(32);
  });

  it("cannot claim to have started in the future (so it cannot always rank as newest)", () => {
    const x = parseServerInfo({ ...good, startedAt: Date.now() + 10 ** 12 })!;
    expect(x.startedAt).toBeLessThanOrEqual(Date.now());
  });
});
