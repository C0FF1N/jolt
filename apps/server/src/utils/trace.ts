import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

import { env } from "@repo/config/env";

/**
 * Opt-in diagnostics. JOLT_TRACE=1 emits one JSON line per event to
 * stderr (or JOLT_TRACE_FILE). Events carry sizes and timings only,
 * never page content, form values, URL query strings or credentials.
 */
export const traceEnabled = env("TRACE") === "1";
const traceFile = env("TRACE_FILE");

const als = new AsyncLocalStorage<{ traceId: string }>();
let seq = 0;

export function withTrace<T>(fn: () => Promise<T>): Promise<T> {
  if (!traceEnabled) return fn();
  return als.run({ traceId: `t${++seq}` }, fn);
}

export function trace(event: string, fields: Record<string, unknown> = {}) {
  if (!traceEnabled) return;
  const line = JSON.stringify({
    ts: Date.now(),
    traceId: als.getStore()?.traceId,
    event,
    ...fields,
  });
  if (traceFile) appendFileSync(traceFile, line + "\n");
  else console.error(line);
}

export const now = (): number => performance.now();
