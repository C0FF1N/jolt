// Deterministic stand-in for the Chrome extension. Speaks the same WS
// protocol ({id,type,payload} -> {type:"messageResponse",payload:{requestId,result|error}}).
// All latencies are SIMULATED parameters, reported with every result.
import { WebSocket } from "ws";

export function makeSnapshot(nodes) {
  const lines = ["- document:"];
  for (let i = 0; i < nodes; i++) {
    const depth = 1 + (i % 4);
    lines.push(`${"  ".repeat(depth)}- button "Item ${i}" [ref=e${i}]`);
  }
  return lines.join("\n");
}

export async function startMockExtension({
  port,
  rttMs = 1, // simulated extension-side processing per message
  snapshotNodes = 50,
  host = "127.0.0.1",
  capabilities = [],
}) {
  const stats = { messages: 0, byType: {} };
  const snapshot = makeSnapshot(snapshotNodes);
  let ws;
  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${host}:${port}`);
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  if (capabilities.length) {
    ws.send(JSON.stringify({ type: "hello", payload: { protocolVersion: 2, capabilities } }));
  }
  ws.on("message", async (data) => {
    const { id, type } = JSON.parse(data.toString());
    stats.messages++;
    stats.byType[type] = (stats.byType[type] ?? 0) + 1;
    if (rttMs) await new Promise((r) => setTimeout(r, rttMs));
    let result;
    switch (type) {
      case "getUrl": result = "http://127.0.0.1/fixture"; break;
      case "getTitle": result = "Fixture"; break;
      case "browser_snapshot": result = snapshot; break;
      case "browser_snapshot_bundle": result = { url: "http://127.0.0.1/fixture", title: "Fixture", snapshot }; break;
      case "browser_get_console_logs": result = []; break;
      case "browser_screenshot": result = "iVBORw0KGgo="; break;
      default: result = undefined;
    }
    ws.send(JSON.stringify({ type: "messageResponse", payload: { requestId: id, result } }));
  });
  return { stats, snapshotBytes: Buffer.byteLength(snapshot), close: () => ws.close() };
}
