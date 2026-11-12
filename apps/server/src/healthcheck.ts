import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig, type ServerConfig } from './config.ts'

// The probe runs inside the container, so a wildcard bind address is reached through loopback.
export function healthcheckUrl(config: Pick<ServerConfig, 'port' | 'host'>): string {
  let host = config.host
  if (host === '0.0.0.0') host = '127.0.0.1'
  else if (host === '::') host = '[::1]'
  else if (host.includes(':')) host = `[${host}]`
  return `http://${host}:${config.port}/api/setup/state`
}

// Not `import.meta.main`: see the same gate in admin.ts (engines floor is below Node 22.18).
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig(process.env)
    const r = await fetch(healthcheckUrl(config), { signal: AbortSignal.timeout(4000) })
    process.exitCode = r.ok ? 0 : 1
  } catch {
    process.exitCode = 1
  }
}
