import { type AXNode, DEFAULT_LIMITS, type SnapshotLimits, buildSnapshot } from "./aria";
import { resolveChord } from "./keys";

/** The only browser surface the handlers need; implemented over chrome.debugger / chrome.tabs. */
export interface Cdp {
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Resolves with the next event named any of `methods`, or rejects after timeoutMs. */
  once(methods: string | string[], timeoutMs: number): Promise<unknown>;
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
const MAX_VALUE_CHECKS = 50;

export function createHandlers({ cdp, consoleLog, limits }: HandlerDeps) {
  let refs = new Map<string, number>();

  const lim = { ...DEFAULT_LIMITS, ...limits };

  async function snapshot(): Promise<string> {
    const { nodes } = await cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    await redactPasswordValues(nodes);
    const built = buildSnapshot(nodes, lim);
    refs = built.refs;
    return built.yaml;
  }

  /**
   * The accessibility tree cannot tell us an <input> is a password field, so look
   * at the DOM for every text box that currently has a value and drop passwords.
   * Bounded: at most MAX_VALUE_CHECKS lookups per snapshot; beyond that values are
   * dropped (fail closed) rather than risk leaking one.
   */
  async function redactPasswordValues(nodes: AXNode[]): Promise<void> {
    const withValue = nodes.filter(
      (n) =>
        n.backendDOMNodeId !== undefined &&
        n.value?.value !== undefined &&
        String(n.value.value) !== "" &&
        ["textbox", "searchbox", "combobox", "spinbutton"].includes(String(n.role?.value)),
    );
    await Promise.all(
      withValue.map(async (n, i) => {
        if (i >= MAX_VALUE_CHECKS) {
          n.value = undefined;
          return;
        }
        try {
          const { node } = await cdp.send<{ node: { attributes?: string[] } }>("DOM.describeNode", {
            backendNodeId: n.backendDOMNodeId,
          });
          const attrs = node.attributes ?? [];
          const typeIdx = attrs.findIndex((a, k) => k % 2 === 0 && a === "type");
          if (typeIdx >= 0 && String(attrs[typeIdx + 1]).toLowerCase() === "password") {
            n.value = undefined;
          }
        } catch {
          n.value = undefined; // unknown element type: fail closed
        }
      }),
    );
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
    // Same-document navigations (hash change, history.pushState, SPA back/forward) never fire
    // "load", so they must also end the wait or each one would stall for the full cap.
    const loaded = cdp
      .once(["Page.loadEventFired", "Page.navigatedWithinDocument"], NAV_TIMEOUT_MS)
      .catch(() => "timeout");
    const result = (await start()) as { errorText?: string } | undefined;
    if (result?.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    // Resolves at the load event; after NAV_TIMEOUT_MS we continue (page may still be loading).
    await loaded;
  }

  async function pressKeyName(name: string) {
    const chord = resolveChord(name);
    type K = { key: string; code: string; windowsVirtualKeyCode: number; text?: string };
    const dispatch = (type: string, k: K, modifiers: number) =>
      cdp.send("Input.dispatchKeyEvent", {
        type,
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        modifiers,
        ...(type === "keyDown" && k.text ? { text: k.text } : {}),
      });
    const bitFor = (key: string): number => ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 })[key as "Alt"] ?? 0;
    let held = 0;
    try {
      for (const m of chord.mods) {
        held |= bitFor(m.key);
        await dispatch("rawKeyDown", m, held);
      }
      const k = chord.key;
      await dispatch(k.text ? "keyDown" : "rawKeyDown", k, chord.modifiers);
      await dispatch("keyUp", k, chord.modifiers);
    } finally {
      // Always release held modifiers, even if the key event itself failed.
      for (const m of [...chord.mods].reverse()) {
        await dispatch("keyUp", m, held).catch(() => undefined);
        held &= ~bitFor(m.key);
      }
    }
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
      if (typeof url !== "string" || !(/^https?:\/\//i.test(url) || url === "about:blank")) {
        throw new Error('Navigation needs an http(s) URL such as "https://example.com" (or about:blank).');
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
      // insertText("") does not delete a selection; use Delete so empty text clears the field.
      if (text === undefined || text === null || text === "") await pressKeyName("Delete");
      else await cdp.send("Input.insertText", { text: String(text) });
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
      if (res.exceptionDetails) {
        const d = res.exceptionDetails as { exception?: { description?: string }; text?: string };
        const detail = String(d.exception?.description ?? d.text ?? "");
        // Our own timer rejects with "timed out"; anything else means the page changed under us.
        if (/timed out/i.test(detail)) throw new Error("timed out");
        throw new Error(
          `The page changed while waiting (${detail.split("\n")[0] || "evaluation failed"}). Take a new snapshot and retry.`,
        );
      }
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
