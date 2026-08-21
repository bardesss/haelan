import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHaelan } from '@haelan/core'
import { readConfig } from './config.ts'
import { buildServer } from './app.ts'

const config = readConfig(process.env)
const instance = openHaelan(config.dataDir)

// The built bundle sits beside the server in the workspace and in the image. Absent during a
// server only dev run, where Vite serves the app on its own port and proxies back here, so a
// missing dist is a normal state rather than a failure.
const webRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'))
const app = buildServer({
  instance,
  now: Date.now,
  fetch: globalThis.fetch,
  ...(existsSync(join(webRoot, 'index.html')) ? { webRoot } : {}),
})

const shutdown = async () => {
  // Before close, so a scheduled tick cannot start a run against a database that is about to
  // be closed underneath it.
  app.haelan.runner.stop()
  await app.close()
  instance.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

await app.listen({ port: config.port, host: config.host })
app.haelan.runner.start()
console.log(`haelan listening on http://${config.host}:${config.port}`)
