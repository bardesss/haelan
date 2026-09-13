export interface ServerConfig {
  dataDir: string
  port: number
  host: string
}

// Spec section 15 promises an install with no environment variables and no edited files, so
// every value here has a working default and the variables exist only for people who disagree.
//
// Only what has to be true before the process can bind a port or open a database lives here.
// Backup retention and the interval between backups used to, and are instance settings now
// (packages/core/src/store/settings.ts): the process is already up and the data directory is
// already open by the time either is read, so they belong beside the buttons that act on them
// rather than in a variable a household has to restart the container to change. What is left of
// the old variables is the one-time seed in maintenance/backupPolicySeed.ts.
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const port = Number(env.HAELAN_PORT ?? 4235)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HAELAN_PORT must be a port number, got ${String(env.HAELAN_PORT)}`)
  }
  return {
    dataDir: env.HAELAN_DATA_DIR ?? '/data',
    port,
    host: env.HAELAN_HOST ?? '0.0.0.0',
  }
}
