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
        case "DOM.describeNode":
          return { node: { attributes: params!.backendNodeId === 11 ? ["type", "password"] : ["type", "text"] } } as any;
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

  it("draws the AI cursor on click and hover without blocking the real action", async () => {
    const { h, calls } = make();
    await h.browser_snapshot({});
    await h.browser_click({ ref: "e2" });
    await h.browser_hover({ ref: "e2" });
    const drawn = calls.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params!.expression));
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toMatch(/\(5, 5, "click"\)$/);
    expect(drawn[1]).toMatch(/\(5, 5, "move"\)$/);
    expect(calls.find((c) => c.method === "Runtime.evaluate")!.params).toMatchObject({ silent: true });
  });

  it("a failing cursor never fails or delays the click", async () => {
    const f = fakeCdp();
    const orig = f.cdp.send.bind(f.cdp);
    f.cdp.send = (async (m: string, p?: Record<string, unknown>) => {
      if (m === "Runtime.evaluate") throw new Error("page is gone");
      return orig(m, p);
    }) as typeof f.cdp.send;
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [] });
    await h.browser_snapshot({});
    await expect(h.browser_click({ ref: "e2" })).resolves.toBeUndefined();
    expect(f.calls.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("draws nothing when the cursor setting is off", async () => {
    const f = fakeCdp();
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [], showCursor: () => false });
    await h.browser_snapshot({});
    await h.browser_click({ ref: "e2" });
    expect(f.calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
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

  it("navigate only allows http(s) and about:blank", async () => {
    const { h } = make();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/secret.txt", "chrome://settings", "about:srcdoc", " https://x"]) {
      await expect(h.browser_navigate({ url: bad })).rejects.toThrow(/http\(s\) URL/);
    }
    await expect(h.browser_navigate({ url: "about:blank" })).resolves.toBeUndefined();
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

  it("never exposes the value of a password input in a snapshot", async () => {
    const f = fakeCdp();
    const origSend = f.cdp.send.bind(f.cdp);
    f.cdp.send = (async (m: string, p?: Record<string, unknown>) => {
      const r: any = await origSend(m, p);
      if (m === "Accessibility.getFullAXTree") {
        r.nodes[1].value = { type: "x", value: "hunter2" }; // node with backend id 11 (a password)
        r.nodes[2].role = { type: "x", value: "textbox" };
        r.nodes[2].value = { type: "x", value: "visible" }; // backend id 12 (type=text)
      }
      return r;
    }) as typeof f.cdp.send;
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [] });
    const yaml = (await h.browser_snapshot({})) as string;
    expect(yaml).not.toContain("hunter2");
    expect(yaml).toContain('[value="visible"]');
  });

  it("fails closed when the element type cannot be determined", async () => {
    const f = fakeCdp();
    const origSend = f.cdp.send.bind(f.cdp);
    f.cdp.send = (async (m: string, p?: Record<string, unknown>) => {
      if (m === "DOM.describeNode") throw new Error("gone");
      const r: any = await origSend(m, p);
      if (m === "Accessibility.getFullAXTree") r.nodes[1].value = { type: "x", value: "secret" };
      return r;
    }) as typeof f.cdp.send;
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [] });
    expect((await h.browser_snapshot({})) as string).not.toContain("secret");
  });

  it("press_key sends a modifier chord: modifiers down, key, then released in reverse", async () => {
    const { h, calls } = make();
    await h.browser_press_key({ key: "Control+Shift+a" });
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => [c.params!.type, c.params!.key, c.params!.modifiers]);
    expect(keys).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Shift", 10],
      ["rawKeyDown", "a", 10],
      ["keyUp", "a", 10],
      ["keyUp", "Shift", 10],
      ["keyUp", "Control", 2],
    ]);
  });

  it("press_key releases held modifiers even if the key event fails", async () => {
    const f = fakeCdp();
    const orig = f.cdp.send.bind(f.cdp);
    f.cdp.send = (async (m: string, p?: Record<string, unknown>) => {
      if (m === "Input.dispatchKeyEvent" && p?.key === "a") throw new Error("boom");
      return orig(m, p);
    }) as typeof f.cdp.send;
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [] });
    await expect(h.browser_press_key({ key: "Control+a" })).rejects.toThrow("boom");
    const ups = f.calls.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params!.type === "keyUp" && c.params!.key === "Control");
    expect(ups).toHaveLength(1);
  });

  it("typing empty text clears the field with Delete instead of a no-op insert", async () => {
    const { h, calls } = make();
    await h.browser_snapshot({});
    await h.browser_type({ ref: "e1", text: "", submit: false });
    expect(calls.some((c) => c.method === "Input.insertText")).toBe(false);
    expect(calls.find((c) => c.method === "Input.dispatchKeyEvent")!.params).toMatchObject({ key: "Delete" });
  });

  it("navigation waits on both the load and same-document events", async () => {
    const seen: unknown[] = [];
    const f = fakeCdp();
    f.cdp.once = (async (m: string | string[]) => {
      seen.push(m);
      return {};
    }) as typeof f.cdp.once;
    const h = createHandlers({ cdp: f.cdp, consoleLog: () => [] });
    await h.browser_navigate({ url: "https://example.com/#x" });
    expect(seen[0]).toEqual(["Page.loadEventFired", "Page.navigatedWithinDocument"]);
  });
});
