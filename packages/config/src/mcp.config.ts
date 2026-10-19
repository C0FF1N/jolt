// JOLT_PORT pins the server to exactly that port (benchmarks/tests, or two setups that must
// not share a range). Without it the server takes the first free port in
// [defaultWsPort, defaultWsPort + portScanCount) so several MCP clients (VS Code, Claude Code, ...)
// can each run their own server at once; the extension scans the same range.
// JOLT_BASE_PORT moves the start of that range without pinning.
//
// The default range (9470-9480) deliberately avoids 9009, the fixed port of the original Browser MCP
// server: the extension probes every port in its range, and a probe must never land on a server that
// would treat it as the real extension and drop the live connection. To use the ORIGINAL extension
// with this server, set JOLT_PORT=9009.
import { env } from "./env";

const envPort = Number(env("PORT"));
const envBase = Number(env("BASE_PORT"));
const portPinned = Number.isInteger(envPort) && envPort > 0;
const basePort = Number.isInteger(envBase) && envBase > 0 ? envBase : 9470;

export const mcpConfig = {
  defaultWsPort: portPinned ? envPort : basePort,
  portPinned,
  /** Keep in sync with DEFAULT_PORT / PORT_SCAN_COUNT in apps/extension/src/policy.ts. */
  portScanCount: 11,
  errors: {
    noConnectedTab: "No tab is connected",
  },
};
