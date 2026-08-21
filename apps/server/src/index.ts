import { openHaelan } from '@haelan/core'
import { readConfig } from './config.ts'
import { buildServer } from './app.ts'

const config = readConfig(process.env)
const instance = openHaelan(config.dataDir)
const app = buildServer({ instance, now: Date.now, fetch: globalThis.fetch })

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
