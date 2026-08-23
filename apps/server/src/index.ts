import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHaelan } from '@haelan/core'
import { readConfig } from './config.ts'
import { buildServer } from './app.ts'
import { rebuildIfNeeded } from './rebuild.ts'

const config = readConfig(process.env)
// Resolved and reported, because a relative HAELAN_DATA_DIR means whatever the working
// directory happened to be, and "where is my data" is the first question an operator asks and
// the last one a log should leave ambiguous.
const dataDir = resolve(config.dataDir)
const instance = openHaelan(dataDir)

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

// Assigned after listen. Declared here so shutdown can wait on it: a rebuild holds a write
// transaction, and closing SQLite underneath one is how a shutdown turns into a stack trace.
let rebuilding: Promise<unknown> = Promise.resolve()

const shutdown = async () => {
  // Stop scheduling first so nothing new begins, then wait for whatever is already running.
  // Closing SQLite under a backfill mid-window is how a shutdown turns into a stack trace.
  app.haelan.runner.stop()
  await app.haelan.runner.settle()
  await rebuilding.catch(() => {})
  await app.close()
  instance.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

await app.listen({ port: config.port, host: config.host })
console.log(`haelan listening on http://${config.host}:${config.port}`)
console.log(`data directory ${dataDir}`)

// After listen, so an upgrade that triggers a rebuild does not delay the first request. Before
// the runner, because a sync landing mid rebuild would write rows the replay has already
// finished listing and would delete without replaying.
rebuilding = rebuildIfNeeded({ instance, nowMs: Date.now, log: (line) => { console.log(line) } })
  .then(() => { app.haelan.runner.start() })
  .catch((error: unknown) => {
    // The rebuild is what makes the derived rows trustworthy, so a failed one must not be
    // followed by a sync appending more rows to a tier nobody has verified. Loud and stopped.
    console.error('rebuild failed, sync not started', error)
  })
