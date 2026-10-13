import { type AXNode, DEFAULT_LIMITS, type SnapshotLimits, buildSnapshot } from "./aria";
import { resolveKey } from "./keys";

/** The only browser surface the handlers need; implemented over chrome.debugger / chrome.tabs. */
export interface Cdp {
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Resolves with the next event named `method`, or rejects after timeoutMs. */
  once(method: string, timeoutMs: number): Promise<unknown>;
  tab(): Promise<{ url: string; title: string }>;
}

export type ConsoleEntry = { type: string; text: string; timestamp: number };

export type HandlerDeps = {
  cdp: Cdp;
  consoleLog: () => ConsoleEntry[];
  limits?: Partial<SnapshotLimits>;
};

type Payload = Record<string, any>;
const NAV_TIMEOUT_MS = 15_000;

export function createHandlers({ cdp, consoleLog, limits }: HandlerDeps) {
  let refs = new Map<string, number>();

  const lim = { ...DEFAULT_LIMITS, ...limits };

  async function snapshot(): Promise<string> {
    const { nodes } = await cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const built = buildSnapshot(nodes, lim);
    refs = built.refs;
    return built.yaml;
  }

  function backendId(ref: string): number {
    const id = refs.get(ref);
    if (id === undefined) {
      throw new Error(
        `Unknown element ref "${ref}". Take a new snapshot and use a ref from it.`,
      );
    }
    return id;
  }

  /** Resolves a ref to a live remote object; stale refs fail with a recovery hint. */
  async function resolve(ref: string): Promise<{ objectId: string; backendNodeId: number }> {
    const backendNodeId = backendId(ref);
    try {
      const { object } = await cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", {
        backendNodeId,
      });
      return { objectId: object.objectId, backendNodeId };
    } catch {
      throw new Error(
        `Element ref "${ref}" is no longer on the page. The page changed; take a new snapshot.`,
      );
    }
  }

  async function center(backendNodeId: number): Promise<{ x: number; y: number }> {
    await cdp
      .send("DOM.scrollIntoViewIfNeeded", { backendNodeId })
      .catch(() => undefined); // best effort; getBoxModel below decides visibility
    let quad: number[];
    try {
      const { model } = await cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", {
        backendNodeId,
      });
      quad = model.content;
    } catch {
      throw new Error("Element is not visible or has no layout box; it cannot be clicked.");
    }
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return {
      x: xs.reduce((a, b) => a + b, 0) / 4,
      y: ys.reduce((a, b) => a + b, 0) / 4,
    };
  }

  async function mouse(type: string, x: number, y: number, extra: Payload = {}) {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });
  }

  async function navigateAndWait(start: () => Promise<unknown>): Promise<void> {
    refs = new Map(); // refs from the old document are stale after navigation
    // Register the load listener BEFORE starting navigation so a fast load is not missed.
    const loaded = cdp.once("Page.loadEventFired", NAV_TIMEOUT_MS).catch(() => "timeout");
    const result = (await start()) as { errorText?: string } | undefined;
    if (result?.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    // Resolves at the load event; after NAV_TIMEOUT_MS we continue (page may still be loading).
    await loaded;
  }

  async function pressKeyName(name: string) {
    const k = resolveKey(name);
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    };
    await cdp.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(k.text ? { text: k.text } : {}),
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  const handlers: Record<string, (p: Payload) => Promise<unknown>> = {
    getUrl: async () => (await cdp.tab()).url,
    getTitle: async () => (await cdp.tab()).title,
    browser_snapshot: snapshot,
    browser_snapshot_bundle: async () => {
      const [{ url, title }, yaml] = await Promise.all([cdp.tab(), snapshot()]);
      return { url, title, snapshot: yaml };
    },

    browser_navigate: async ({ url }) => {
      if (typeof url !== "string" || !/^(https?|file|about|chrome):/i.test(url)) {
        throw new Error('Navigation needs an absolute URL such as "https://example.com".');
      }
      await navigateAndWait(() => cdp.send("Page.navigate", { url }));
    },
    browser_go_back: async () => history(-1),
    browser_go_forward: async () => history(1),

    browser_click: async ({ ref }) => {
      const { backendNodeId } = await resolve(ref);
      const { x, y } = await center(backendNodeId);
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
    },
    browser_hover: async ({ ref }) => {
      const { backendNodeId } = await resolve(ref);
      const { x, y } = await center(backendNodeId);
      await mouse("mouseMoved", x, y);
    },
    browser_type: async ({ ref, text, submit }) => {
      const { objectId, backendNodeId } = await resolve(ref);
      await cdp.send("DOM.focus", { backendNodeId });
      // Replace existing content: select it, then insertText overwrites the selection.
      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(){ if (typeof this.select === 'function') this.select();
          else if (this.isContentEditable) { const s = getSelection(); s.selectAllChildren(this); } }`,
      });
      await cdp.send("Input.insertText", { text: String(text ?? "") });
      if (submit) await pressKeyName("Enter");
    },
    browser_select_option: async ({ ref, values }) => {
      if (!Array.isArray(values)) throw new Error("`values` must be an array of strings.");
      const { objectId } = await resolve(ref);
      const res = await cdp.send<{ result: { value?: { ok: boolean; missing?: string[] } } }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          returnByValue: true,
          arguments: [{ value: values }],
          functionDeclaration: `function(vals){
            if (this.tagName !== 'SELECT') return { ok:false, missing: vals };
            const missing = [];
            const opts = Array.from(this.options);
            for (const o of opts) o.selected = false;
            for (const v of vals) {
              const o = opts.find(o => o.value === v) || opts.find(o => o.label === v || o.text === v);
              if (o) o.selected = true; else missing.push(v);
            }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: missing.length === 0, missing };
          }`,
        },
      );
      const out = res.result.value;
      if (!out?.ok) {
        throw new Error(
          `Could not select ${JSON.stringify(out?.missing ?? values)}: not a <select> or no matching option.`,
        );
      }
    },
    browser_press_key: async ({ key }) => pressKeyName(String(key)),
    browser_wait: async ({ time }) => {
      const ms = Math.max(0, Math.min(Number(time) || 0, 300)) * 1000;
      await new Promise((r) => setTimeout(r, ms));
    },
    browser_wait_for: async ({ text, textGone, timeoutMs }) => {
      const limit = Math.max(100, Math.min(Number(timeoutMs) || 10_000, 60_000));
      const expr = `new Promise((resolve, reject) => {
        const wantText = ${JSON.stringify(text ?? null)};
        const goneText = ${JSON.stringify(textGone ?? null)};
        const met = () => {
          const t = document.body ? document.body.innerText : '';
          return (wantText === null || t.includes(wantText)) && (goneText === null || !t.includes(goneText));
        };
        if (met()) return resolve(true);
        const done = (fn) => { obs.disconnect(); clearTimeout(timer); fn(); };
        const obs = new MutationObserver(() => { if (met()) done(() => resolve(true)); });
        obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        const timer = setTimeout(() => done(() => reject(new Error('timed out'))), ${limit});
      })`;
      const res = await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) throw new Error("timed out");
    },
    browser_screenshot: async () => {
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
      });
      return data;
    },
    browser_get_console_logs: async () => consoleLog(),
  };

  async function history(delta: -1 | 1) {
    const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
      "Page.getNavigationHistory",
    );
    const target = h.entries[h.currentIndex + delta];
    if (!target) {
      throw new Error(delta < 0 ? "No previous page in history." : "No next page in history.");
    }
    await navigateAndWait(() =>
      cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }),
    );
  }

  return handlers;
}

export const CAPABILITIES = ["snapshotBundle", "waitFor"] as const;
