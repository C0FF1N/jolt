// BROWSERMCP_PORT is a turbo addition so benchmarks/tests can avoid the
// default port (9009), which a running Browser MCP server may own. The
// default is unchanged.
const envPort = Number(process.env.BROWSERMCP_PORT);

export const mcpConfig = {
  defaultWsPort: Number.isInteger(envPort) && envPort > 0 ? envPort : 9009,
  errors: {
    noConnectedTab: "No tab is connected",
  },
};
