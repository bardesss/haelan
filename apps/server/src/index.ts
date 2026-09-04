import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHaelan } from '@haelan/core'
import { readConfig } from './config.ts'
import { buildServer } from './app.ts'
import { runBootSequence } from './rebuild.ts'
import { rebuildInWorker } from './rebuildInWorker.ts'

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

// After listen, so the app is reachable before a rebuild even starts. That ordering alone used to
// be the whole of the claim and it was false: runRebuild has no awaits, so calling it directly
// blocked the event loop solid for its entire duration and Fastify answered nothing, not even an
// error, for as long as fifteen minutes on real data. rebuildInWorker moves that synchronous loop
// onto its own thread (see rebuildWorker.ts), which is what actually keeps this thread free to
// serve while the rebuild runs; WAL lets its write transaction sit alongside this thread's reads
// (packages/core/src/db/open.ts). The rest of the ordering (before the runner, and never
// rejecting) lives in runBootSequence itself, in rebuild.ts, where a test can hold a mutation
// against it; this is wiring only.
rebuilding = runBootSequence({
  rebuild: () => rebuildInWorker({ dataDir, log: (line) => { console.log(line) } }),
  startSync: () => { app.haelan.runner.start() },
  log: (line) => { console.log(line) },
  logError: (message, error) => { console.error(message, error) },
})
