import { describe, expect, it } from "vitest";

import type { AXNode } from "./aria";
import { type Cdp, createHandlers } from "./handlers";

const v = (value: unknown) => ({ type: "x", value });

type Call = { method: string; params?: Record<string, unknown> };

function fakeCdp(opts: { alive?: Set<number>; loadEvent?: "fires" | "never" } = {}) {
  const calls: Call[] = [];
  const alive = opts.alive ?? new Set([11, 12]);
  const tree = [
    { nodeId: "1", role: v("RootWebArea"), name: v("T"), childIds: ["2", "3"] },
    { nodeId: "2", parentId: "1", role: v("textbox"), name: v("Email"), backendDOMNodeId: 11 },
    { nodeId: "3", parentId: "1", role: v("button"), name: v("Go"), backendDOMNodeId: 12 },
  ] as AXNode[];
  const cdp: Cdp = {
    async send(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "Accessibility.getFullAXTree":
          return { nodes: tree } as any;
        case "DOM.resolveNode":
          if (!alive.has(params!.backendNodeId as number)) throw new Error("No node");
          return { object: { objectId: `o${params!.backendNodeId}` } } as any;
        case "DOM.getBoxModel":
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } as any;
        case "Page.navigate":
          return { frameId: "f" } as any;
        case "Page.getNavigationHistory":
          return { currentIndex: 1, entries: [{ id: 5 }, { id: 6 }] } as any;
        case "Runtime.callFunctionOn":
          return { result: { value: { ok: true } } } as any;
        default:
          return {} as any;
      }
    },
    once: () =>
      opts.loadEvent === "never"
        ? new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20))
        : Promise.resolve({}),
    tab: async () => ({ url: "http://t/", title: "T" }),
  };
  return { cdp, calls };
}

const make = (o?: Parameters<typeof fakeCdp>[0]) => {
  const f = fakeCdp(o);
  return {
    ...f,
    h: createHandlers({
      cdp: f.cdp,
      consoleLog: () => [{ type: "log", text: "hi", timestamp: 1 }],
    }),
  };
};

describe("extension handlers", () => {
  it("snapshot bundle returns url, title and yaml in one call", async () => {
    const { h } = make();
    const r = (await h.browser_snapshot_bundle({})) as { url: string; title: string; snapshot: string };
    expect(r.url).toBe("http://t/");
    expect(r.snapshot).toContain('textbox "Email" [ref=e1]');
  });

  it("click measures the box and dispatches move/press/release at its centre", async () => {
    const { h, calls } = make();
    await h.browser_snapshot({});
    await h.browser_click({ ref: "e2" });
    const mouse = calls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params!.type);
    expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(calls.find((c) => c.method === "Input.dispatchMouseEvent")!.params).toMatchObject({ x: 5, y: 5 });
  });

  it("rejects an unknown ref with a recovery hint", async () => {
    const { h } = make();
    await h.browser_snapshot({});
    await expect(h.browser_click({ ref: "e99" })).rejects.toThrow(/take a new snapshot/i);
  });

  it("reports a stale ref when the node left the page", async () => {
    const { h } = make({ alive: new Set() });
    await h.browser_snapshot({});
    await expect(h.browser_click({ ref: "e1" })).rejects.toThrow(/no longer on the page/);
  });

  it("type focuses, inserts text, and presses Enter on submit", async () => {
    const { h, calls } = make();
    await h.browser_snapshot({});
    await h.browser_type({ ref: "e1", text: "a@b.c", submit: true });
    expect(calls.map((c) => c.method)).toContain("DOM.focus");
    expect(calls.find((c) => c.method === "Input.insertText")!.params).toEqual({ text: "a@b.c" });
    expect(calls.filter((c) => c.method === "Input.dispatchKeyEvent").length).toBe(2);
  });

  it("navigate rejects non-http URLs such as javascript:", async () => {
    const { h } = make();
    await expect(h.browser_navigate({ url: "javascript:alert(1)" })).rejects.toThrow(/absolute URL/);
    await expect(h.browser_navigate({ url: "https://example.com" })).resolves.toBeUndefined();
  });

  it("navigate does not hang when the load event never fires", async () => {
    const { h } = make({ loadEvent: "never" });
    await expect(h.browser_navigate({ url: "https://example.com" })).resolves.toBeUndefined();
  });

  it("go_back uses history and errors past the end of history", async () => {
    const { h, calls } = make();
    await h.browser_go_back({});
    expect(calls.find((c) => c.method === "Page.navigateToHistoryEntry")!.params).toEqual({ entryId: 5 });
    await expect(h.browser_go_forward({})).rejects.toThrow(/No next page/);
  });

  it("invalidates refs after navigation", async () => {
    const { h } = make();
    await h.browser_snapshot({});
    await h.browser_navigate({ url: "https://example.com" });
    await expect(h.browser_click({ ref: "e1" })).rejects.toThrow(/Unknown element ref/);
  });

  it("returns collected console entries", async () => {
    const { h } = make();
    expect(await h.browser_get_console_logs({})).toEqual([{ type: "log", text: "hi", timestamp: 1 }]);
  });
});
