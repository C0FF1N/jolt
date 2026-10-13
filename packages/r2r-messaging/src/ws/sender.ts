// Verbatim runtime behavior of the published @browsermcp/mcp@0.1.3 bundle
// (packages-r2r/messaging/src/ws/sender.ts). Kept unmodified so `baseline`
// measures the original protocol code. The turbo server replaces this module.
import { WebSocket } from "ws";

import type {
  MessagePayload,
  MessageResponse,
  MessageType,
} from "@repo/messaging/types";

import { MESSAGE_RESPONSE_TYPE } from "./types";

export function createSocketMessageSender<TMap>(ws: WebSocket) {
  async function sendSocketMessage<T extends MessageType<TMap>>(
    type: T,
    payload: MessagePayload<TMap, T>,
    options: { timeoutMs?: number } = { timeoutMs: 30000 },
  ): Promise<MessageResponse<TMap, T>> {
    const { timeoutMs } = options;
    const id = generateId();
    const message = { id, type, payload };

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        removeSocketMessageResponseListener();
        ws.removeEventListener("error", errorHandler);
        ws.removeEventListener("close", cleanup);
        clearTimeout(timeoutId);
      };

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`WebSocket response timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      const removeSocketMessageResponseListener =
        addSocketMessageResponseListener(ws, (responseMessage) => {
          const { payload } = responseMessage;
          if (payload.requestId !== id) {
            return;
          }
          const { result, error } = payload;
          if (error) {
            reject(new Error(error));
          } else {
            resolve(result);
          }
          cleanup();
        });

      const errorHandler = (_event: unknown) => {
        cleanup();
        reject(new Error("WebSocket error occurred"));
      };

      ws.addEventListener("error", errorHandler);
      ws.addEventListener("close", cleanup);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        cleanup();
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  return { sendSocketMessage };
}

type ResponseMessage = {
  type: string;
  payload: { requestId: string; result?: any; error?: string };
};

function addSocketMessageResponseListener(
  ws: WebSocket,
  typeListener: (message: ResponseMessage) => void | Promise<void>,
) {
  const listener = async (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as ResponseMessage;
    if (message.type !== MESSAGE_RESPONSE_TYPE) {
      return;
    }
    await typeListener(message);
  };
  ws.addEventListener("message", listener as any);
  return () => ws.removeEventListener("message", listener as any);
}

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${randomStr}`;
}
