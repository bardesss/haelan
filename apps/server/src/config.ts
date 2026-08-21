export interface ServerConfig {
  dataDir: string
  port: number
  host: string
}

// Spec section 15 promises an install with no environment variables and no edited files, so
// every value here has a working default and the variables exist only for people who disagree.
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
