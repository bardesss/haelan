import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHaelan, vacuumIfBloated } from '@haelan/core'
import { readConfig } from './config.ts'
import { buildServer } from './app.ts'
import { runBootSequence } from './rebuild.ts'
import { rebuildInWorkerIfNeeded } from './rebuildInWorker.ts'
import { MaintenanceTick } from './maintenance/tick.ts'

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

// Constructed here, beside the rest of the boot wiring, and started once the rebuild has settled
// below - a vacuum and a backup both open their own connection to the same file, and only the
// rebuild worker's own completion says that file is free of a second writer.
const maintenance = new MaintenanceTick({
  instance, dir: dataDir, keep: config.backupKeep, intervalHours: config.backupIntervalHours,
  now: Date.now,
})

// Assigned after listen. Declared here so shutdown can wait on it: a rebuild holds a write
// transaction, and closing SQLite underneath one is how a shutdown turns into a stack trace.
let rebuilding: Promise<unknown> = Promise.resolve()

const shutdown = async () => {
  // Stop scheduling first so nothing new begins, then wait for whatever is already running.
  // Closing SQLite under a backfill mid-window is how a shutdown turns into a stack trace.
  //
  // Both schedulers, not just the sync one. The maintenance timer is hourly and unref'd, so the
  // window is narrow and the consequence would be a backup starting against a database this
  // function is about to close - the same stack trace, from the other timer.
  app.haelan.runner.stop()
  maintenance.stop()
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
// be the whole of the claim and it was not enough: runRebuild has no awaits, so one person's
// rebuild ran to completion inside a single turn of the event loop and Fastify answered nothing,
// not even an error, for as long as fifteen minutes on real data. rebuildIfNeeded's `await
// setImmediate()` opens a gap between people, which is real but only helps a household of more
// than one, and this instance had one person. rebuildInWorker moves the whole loop onto its own
// thread (see rebuildWorker.ts), which is what actually keeps this thread free to serve however
// many people there are; WAL lets its write transaction sit alongside this thread's reads
// (packages/core/src/db/open.ts). The ...IfNeeded variant spawns that thread only when somebody
// needs rebuilding, so an ordinary restart pays neither the spawn nor the chance of failing to
// spawn. The rest of the ordering (before the runner, and never rejecting) lives in
// runBootSequence itself, in rebuild.ts, where a test can hold a mutation against it; this is
// wiring only.
rebuilding = runBootSequence({
  rebuild: () => rebuildInWorkerIfNeeded({ instance, dataDir, log: (line) => { console.log(line) } }),
  startSync: () => { app.haelan.runner.start() },
  log: (line) => { console.log(line) },
  logError: (message, error) => { console.error(message, error) },
})

// Hung off the same promise, not branched on whether a rebuild actually ran: rebuilding resolves
// immediately in the no-rebuild case too, so one chain covers both and a vacuum can never begin
// while the rebuild worker still holds its own connection to the file. That means it runs while
// the server is already serving - accepted, because better-sqlite3 is synchronous and this
// process holds one connection, so it is a stall (about 1.5s on an 891 MB database) rather than a
// lock conflict. The maintenance tick starts here too, once, for the same reason: it must not
// take its first tick until the file it is about to back up is settled.
rebuilding = rebuilding.then(() => {
  const outcome = vacuumIfBloated(instance.db, dataDir)
  if (outcome.ran) {
    console.log(`reclaimed ${Math.round(outcome.reclaimedBytes / 1_000_000)} MB in ${outcome.ms} ms`)
  } else if (outcome.reason === 'not_enough_disk') {
    // Logged rather than thrown: it is a correct decision about the machine's state, and it is
    // the one an operator most needs to hear, since the space stays spent until they act.
    console.log(`${Math.round(outcome.bloat.freeBytes / 1_000_000)} MB is reclaimable, but the disk cannot hold a second copy`)
  }
  maintenance.start()
})
