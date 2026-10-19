/**
 * Reads a Jolt setting from the environment: `JOLT_<NAME>`, falling back to the legacy
 * `BROWSERMCP_<NAME>` so setups written before the rename keep working.
 */
export function env(name: string): string | undefined {
  return process.env[`JOLT_${name}`] ?? process.env[`BROWSERMCP_${name}`];
}
