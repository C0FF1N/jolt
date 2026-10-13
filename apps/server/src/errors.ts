export type ErrorCode =
  | "NO_CONNECTION"
  | "DISCONNECTED"
  | "REPLACED"
  | "TIMEOUT"
  | "BACKPRESSURE"
  | "EXTENSION_ERROR"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED";

/** Structured, actionable error. `hint` tells the caller how to recover. */
export class BrowserMcpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly operation?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "BrowserMcpError";
  }

  format(): string {
    const op = this.operation ? ` [${this.operation}]` : "";
    return `${this.code}${op}: ${this.message}${this.hint ? `\nHint: ${this.hint}` : ""}`;
  }
}
