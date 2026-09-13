import type { FastifyInstance } from 'fastify'
import {
  vacuumDecision, vacuumIfBloated, runBackup, listBackups, pruneBackups, backupDecision, databaseBloat,
} from '@haelan/core'
import type { BackupFile } from '@haelan/core'
import { sendCoreError, errorBody } from '../api/envelope.ts'

/** What both POST routes answer when a second connection might still be open on the file - see
 * ServerDeps.rebuildInFlight for which one and why. Its own string rather than one of
 * vacuumDecision's or backupDecision's reasons: this is not a fact about bloat, disk or
 * retention, so folding it into either gate's own type would teach a core function about a
 * server-only hazard it has no way to observe. */
const REBUILD_IN_PROGRESS = 'rebuild_in_progress' as const

interface BackupPolicyBody { keep?: unknown, intervalHours?: unknown }

// path stays server side. Nothing here needs the filesystem location of another household's
// backup folder, and nothing should be able to ask the browser to send it back. One function
// rather than one strip per handler: a comment on a single GET route did not stop a POST route
// eleven lines below it from sending the whole object, so the shape that cannot disagree with
// itself is the one written once and called from both.
function withoutPath(file: BackupFile): Omit<BackupFile, 'path'> {
  const { name, takenAtMs, bytes } = file
  return { name, takenAtMs, bytes }
}

/**
 * The household's view of the two M5d units: how bloated the live file is, what backups exist,
 * how often one is taken and how many are kept, and the two buttons that act on either. Admin only, like every instance-wide setting - a
 * backup and a vacuum both touch the one database file every person's data lives in, which is
 * exactly what registerSettings's own requireAdmin gate exists for.
 *
 * dataDir comes from ServerDeps rather than process.env, so a test can point a run at its own
 * temp directory - see ServerDeps.dataDir. Retention and the interval between backups come from
 * the instance settings row, read on every request rather than captured at boot: they used to be
 * HAELAN_BACKUP_KEEP and HAELAN_BACKUP_INTERVAL_HOURS, and a household changing either on the
 * card below must not have to restart the container for this file to agree with them.
 */
export function registerMaintenance(app: FastifyInstance): void {
  // A scope of its own, the same device registerInviteRoutes uses (routes/invite.ts), so
  // setErrorHandler below catches only what these four routes throw. Fastify's own default
  // error handler sends err.message, and a Node fs failure inside runBackup - ENOSPC on
  // VACUUM INTO or on the rename, both real possibilities on a full volume - carries the
  // absolute path of this household's backup folder on both sides of the arrow. withoutPath
  // below exists specifically so that path never leaves the process on the routes that succeed;
  // a route that then handed it straight back on the one path that fails would undo exactly
  // that. requireSession and requireAdmin are decorated on the root app before this file is ever
  // registered (app.ts), so the child scope below inherits both.
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))
    const guard = [scope.requireSession, scope.requireAdmin]

    scope.get('/api/settings/maintenance', { preHandler: guard }, async (_request, reply) => {
      const { instance, dataDir } = app.haelan
      const { keep, intervalHours } = app.haelan.stores.settings.backupPolicy()
      const backups = listBackups(dataDir).map(withoutPath)
      // Read only, through the same three-gate decision vacuumIfBloated itself uses rather than a
      // second copy of its disk-margin comparison: a GET must not decide whether to vacuum, only
      // preview the one branch of that decision an operator cannot already read off the bloat
      // figures below. below_fraction and below_floor both mean there is nothing worth reclaiming
      // yet, which freeFraction and freeBytes already say for themselves; not_enough_disk is the
      // one an operator has to be told, because it stays true until they free space, and the
      // reclaim button alone would only report it after being clicked. Routing both through
      // vacuumDecision means this can never call it "blocked" for a database reclaim would decline
      // for an unrelated, much less alarming reason.
      const decision = vacuumDecision(instance.db, dataDir)
      const vacuumBlocked = !decision.run && decision.reason === 'not_enough_disk'
      return reply.send({
        bloat: decision.bloat, backups, keep, intervalHours, vacuumBlocked,
      })
    })

    // The two numbers together, never one at a time: null in either column is what the one-time
    // seed from the old environment variables reads as "nobody has chosen yet", so a half-written
    // policy would invite a variable left behind in a compose file to fill the other half on the
    // next boot. SettingsStore.putBackupPolicy carries the same reason from the other side.
    //
    // A 404 rather than a write when there is no settings row: this route is only reachable once
    // the wizard is done, which is also when the row exists, so an absent row is a state this
    // cannot repair by inventing a baseUrl and a consent path to insert alongside the two numbers.
    scope.put<{ Body: BackupPolicyBody }>('/api/settings/maintenance/backup-policy', { preHandler: guard }, async (request, reply) => {
      const { keep, intervalHours } = request.body ?? {}
      if (typeof keep !== 'number' || typeof intervalHours !== 'number') {
        return reply.code(400).send(errorBody('config', 'config', 'keep and intervalHours are both required'))
      }
      const settings = app.haelan.stores.settings
      if (!settings.get()) {
        return reply.code(404).send(errorBody('config', 'config', 'this instance has no settings row yet'))
      }
      // Range errors come back through the scope's own error handler as the ConfigError they are,
      // which sendCoreError renders as a 400 carrying the bound that was missed - the same message
      // the store would give any other caller, rather than a second opinion written here.
      settings.putBackupPolicy({ keep, intervalHours }, app.haelan.now())
      return reply.send({ keep, intervalHours })
    })

    scope.post('/api/settings/maintenance/backup', { preHandler: guard }, async (_request, reply) => {
      const { instance, dataDir, rebuildInFlight } = app.haelan
      const { keep } = app.haelan.stores.settings.backupPolicy()
      // The boot rebuild worker is a real second writer on its own thread (rebuildWorker.ts), and
      // both routes below are reachable from listen(), which precedes it - the comment on the
      // boot vacuum used to claim a vacuum could never begin while that worker holds its
      // connection, true only of the boot path. VACUUM INTO would not corrupt anything against a
      // live writer, but verifyBackup compares its copy's row counts against a database the
      // worker may have advanced in between the copy and the comparison, rejecting a perfectly
      // good backup and leaving an orphan .part. Declining here is simpler than teaching
      // verifyBackup to tolerate a moving target for a window that closes on its own within
      // seconds of boot.
      if (rebuildInFlight?.()) return reply.send({ ran: false, reason: REBUILD_IN_PROGRESS })
      // Spec section 1's reason B and C are one unit: the same disk-margin comparison the vacuum
      // uses, asked through the one function both this route and the nightly tick call (see
      // backupDecision's own comment in packages/core/src/backup/runBackup.ts) rather than each
      // carrying a copy that could disagree with the other. keep <= 0 is the other half: an
      // household that set retention to zero to turn backups off, the way the card says they can,
      // used to get a copy written here regardless, with pruneBackups(dir, 0) - which deletes
      // nothing - the only thing standing between them and an unbounded folder.
      const decision = backupDecision(instance.db, dataDir, keep)
      if (!decision.run) return reply.send({ ran: false, reason: decision.reason })
      const file = runBackup({ db: instance.db, dir: dataDir, nowMs: app.haelan.now() })
      // Mirrors the nightly tick (maintenance/tick.ts): a backup taken by hand still counts
      // against keep, or a person clicking the button ten times in a row would grow the folder
      // without bound while the schedule's own backups stay capped.
      pruneBackups(dataDir, keep)
      return reply.send({ ran: true, ...withoutPath(file) })
    })

    scope.post('/api/settings/maintenance/reclaim', { preHandler: guard }, async (_request, reply) => {
      const { instance, dataDir, rebuildInFlight } = app.haelan
      // See the identical check on the backup route above for why; here a VACUUM against the
      // worker's own write transaction would block the whole event loop for the full
      // busy_timeout and then 500 rather than merely producing a copy verifyBackup could reject.
      if (rebuildInFlight?.()) {
        return reply.send({ ran: false, reason: REBUILD_IN_PROGRESS, bloat: databaseBloat(instance.db) })
      }
      // Always a 200: a declined vacuum is a correct outcome, not a failure, and vacuumIfBloated's
      // own return type already says so. See its own comment for why refusing is not an exception.
      const outcome = vacuumIfBloated(instance.db, dataDir)
      return reply.send(outcome)
    })
  })
}
