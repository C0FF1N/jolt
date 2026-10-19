// Injected (Page.addScriptToEvaluateOnNewDocument) into the REAL popup.html when it is rendered for store
// screenshots, so every state is deterministic and shows no real servers, tabs or personal data.
// The scenario is chosen by the URL hash: popup.html#connected | choose | reconnecting.
(() => {
  if (!/popup\.html$/.test(location.pathname)) return;
  const scenario = location.hash.slice(1) || "connected";
  const now = Date.now();
  const srv = (port, client, connected, startedAt) => ({
    name: "Jolt", version: "1.0.0", protocolVersion: 2, pid: port, port, startedAt, client, connected,
  });
  const claude = srv(9470, "claude-code", false, now - 600000);
  const vscode = srv(9471, "vscode", false, now - 300000);
  const scenarios = {
    connected: {
      status: { state: "connected", tabId: 1, port: 9470, pinned: false, server: { ...claude, connected: true }, rttMs: 0.4 },
      servers: [{ ...claude, connected: true }, vscode],
    },
    choose: { status: { state: "idle", port: 9470, pinned: false }, servers: [claude, vscode] },
    reconnecting: {
      status: { state: "waiting", tabId: 1, port: 9470, pinned: false, server: claude, attempt: 2, nextRetryAt: now + 2200 },
      servers: [vscode],
    },
  };
  const s = scenarios[scenario] ?? scenarios.connected;
  const tab = { id: 1, url: "https://shop.example.com/checkout", title: "Checkout · Example Shop", favIconUrl: "" };
  const respond = (m) => (m?.type === "scan" ? { ...s.status, servers: s.servers } : s.status);
  window.chrome = {
    runtime: {
      sendMessage: async (m) => respond(m),
      onMessage: { addListener() {} },
      getManifest: () => ({ version: "1.0.0" }),
    },
    tabs: { query: async () => [tab], get: async () => tab },
    storage: { local: { get: async () => ({ showCursor: true }), set: async () => {} } },
  };
  // Tell the marketing frame how tall this popup is so the iframe can fit it exactly.
  addEventListener("load", () =>
    setTimeout(() => parent.postMessage({ joltHeight: Math.ceil(document.querySelector(".panel").getBoundingClientRect().height) }, "*"), 700),
  );
})();
