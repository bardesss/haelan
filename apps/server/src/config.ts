export interface ServerConfig {
  dataDir: string
  port: number
  host: string
  backupKeep: number
  backupIntervalHours: number
}

// Spec section 15 promises an install with no environment variables and no edited files, so
// every value here has a working default and the variables exist only for people who disagree.
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const port = Number(env.HAELAN_PORT ?? 4235)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HAELAN_PORT must be a port number, got ${String(env.HAELAN_PORT)}`)
  }
  // Zero is not an oversight here: it is how an operator who backs the volume up by other means
  // turns this off, so the floor is zero rather than one the way port's and interval's are.
  const backupKeep = Number(env.HAELAN_BACKUP_KEEP ?? 7)
  if (!Number.isInteger(backupKeep) || backupKeep < 0) {
    throw new Error(`HAELAN_BACKUP_KEEP must be zero or more, got ${String(env.HAELAN_BACKUP_KEEP)}`)
  }
  const backupIntervalHours = Number(env.HAELAN_BACKUP_INTERVAL_HOURS ?? 24)
  if (!Number.isInteger(backupIntervalHours) || backupIntervalHours < 1) {
    throw new Error(`HAELAN_BACKUP_INTERVAL_HOURS must be at least 1, got ${String(env.HAELAN_BACKUP_INTERVAL_HOURS)}`)
  }
  return {
    dataDir: env.HAELAN_DATA_DIR ?? '/data',
    port,
    host: env.HAELAN_HOST ?? '0.0.0.0',
    backupKeep,
    backupIntervalHours,
  }
}
