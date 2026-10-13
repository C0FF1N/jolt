type Status = {
  state: "idle" | "connecting" | "connected" | "error";
  tabId?: number;
  error?: string;
  port: number;
};

const statusEl = document.getElementById("status") as HTMLElement;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const portEl = document.getElementById("port") as HTMLInputElement;

async function ask<T>(msg: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

async function render() {
  const s = await ask<Status>({ type: "status" });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const here = tab?.id !== undefined && tab.id === s.tabId;
  if (s.state === "connected") {
    statusEl.textContent = here ? "Connected to this tab." : "Connected to another tab.";
    toggle.textContent = "Disconnect";
    portEl.value = String(s.port);
  } else {
    statusEl.textContent =
      s.state === "error"
        ? `Error: ${s.error ?? "unknown"}`
        : s.state === "connecting"
          ? "Connecting…"
          : "Not connected.";
    toggle.textContent = "Connect this tab";
  }
  portEl.disabled = s.state === "connected";
  toggle.disabled = s.state === "connecting";
  toggle.dataset.action = s.state === "connected" ? "disconnect" : "connect";
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  if (toggle.dataset.action === "disconnect") {
    await ask({ type: "disconnect" });
  } else {
    const port = Number(portEl.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      statusEl.textContent = "Port must be between 1024 and 65535.";
      toggle.disabled = false;
      return;
    }
    await chrome.storage.local.set({ port });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await ask({ type: "connect", tabId: tab.id, port });
  }
  await render();
});

void (async () => {
  const { port } = (await chrome.storage.local.get("port")) as { port?: number };
  if (port) portEl.value = String(port);
  await render();
})();
