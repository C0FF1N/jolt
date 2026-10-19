import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script, no type declarations
import { launchSpec, mergeVsCodeConfig, vscodeUserConfigPath } from "../../scripts/setup.mjs";

const entry = { type: "stdio", command: "node", args: ["/srv/jolt-server.mjs"] };

describe("setup: what gets registered", () => {
  it("runs the local build with node by default", () => {
    expect(launchSpec({ npx: false }, "/x/jolt-server.mjs")).toEqual({ command: "node", args: ["/x/jolt-server.mjs"] });
  });

  it("--npx registers the published package, wrapped for Claude Code on Windows only", () => {
    expect(launchSpec({ npx: true }, "", "linux")).toEqual({ command: "npx", args: ["-y", "jolt-mcp"], windowsWrapped: false });
    expect(launchSpec({ npx: true }, "", "win32")).toMatchObject({ windowsWrapped: true });
  });
});

describe("setup: VS Code mcp.json merge", () => {
  it("creates the file content when there was none", () => {
    const r = mergeVsCodeConfig(undefined, "jolt", entry);
    expect(r.action).toBe("added");
    expect(JSON.parse(r.text)).toEqual({ servers: { jolt: entry } });
  });

  it("treats an empty file like a missing one", () => {
    expect(mergeVsCodeConfig("  \n", "jolt", entry).action).toBe("added");
  });

  it("keeps every other server and top-level key", () => {
    const before = JSON.stringify({ inputs: [{ id: "x" }], servers: { other: { command: "x" } } });
    const r = mergeVsCodeConfig(before, "jolt", entry);
    expect(JSON.parse(r.text)).toEqual({ inputs: [{ id: "x" }], servers: { other: { command: "x" }, jolt: entry } });
  });

  it("never replaces an existing entry unless forced", () => {
    const before = JSON.stringify({ servers: { jolt: { command: "old" } } });
    expect(mergeVsCodeConfig(before, "jolt", entry)).toEqual({ action: "exists" });
    const forced = mergeVsCodeConfig(before, "jolt", entry, { force: true });
    expect(forced.action).toBe("replaced");
    expect(JSON.parse(forced.text).servers.jolt).toEqual(entry);
  });

  it("refuses to touch a file it cannot parse (comments, trailing commas, wrong shape)", () => {
    expect(mergeVsCodeConfig('{ // my servers\n "servers": {} }', "jolt", entry)).toEqual({ action: "unparsable" });
    expect(mergeVsCodeConfig('{ "servers": {}, }', "jolt", entry)).toEqual({ action: "unparsable" });
    expect(mergeVsCodeConfig("[]", "jolt", entry)).toEqual({ action: "unparsable" });
    expect(mergeVsCodeConfig("null", "jolt", entry)).toEqual({ action: "unparsable" });
    expect(mergeVsCodeConfig('{ "servers": [] }', "jolt", entry)).toEqual({ action: "unparsable" });
    expect(mergeVsCodeConfig('{ "servers": null }', "jolt", entry)).toEqual({ action: "unparsable" });
  });

  it("finds the user-level config per platform", () => {
    expect(vscodeUserConfigPath("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a")).toBe(
      path.join("C:\\Users\\a\\AppData\\Roaming", "Code", "User", "mcp.json"),
    );
    expect(vscodeUserConfigPath("darwin", {}, "/Users/a")).toBe(path.join("/Users/a", "Library", "Application Support", "Code", "User", "mcp.json"));
    expect(vscodeUserConfigPath("linux", {}, "/home/a")).toBe(path.join("/home/a", ".config", "Code", "User", "mcp.json"));
    expect(vscodeUserConfigPath("linux", { XDG_CONFIG_HOME: "/x" }, "/home/a")).toBe(path.join("/x", "Code", "User", "mcp.json"));
  });
});
