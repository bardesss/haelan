import type { FastifyInstance } from 'fastify'
import {
  vacuumDecision, vacuumIfBloated, runBackup, listBackups, pruneBackups,
} from '@haelan/core'
import type { BackupFile } from '@haelan/core'

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
 * and the two buttons that act on either. Admin only, like every instance-wide setting - a
 * backup and a vacuum both touch the one database file every person's data lives in, which is
 * exactly what registerSettings's own requireAdmin gate exists for.
 *
 * dataDir, backupKeep and backupIntervalHours come from ServerDeps rather than process.env, so a
 * test can point a run at its own temp directory - see ServerDeps.dataDir.
 */
export function registerMaintenance(app: FastifyInstance): void {
  const guard = [app.requireSession, app.requireAdmin]

  app.get('/api/settings/maintenance', { preHandler: guard }, async (_request, reply) => {
    const { instance, dataDir, backupKeep, backupIntervalHours } = app.haelan
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
      bloat: decision.bloat, backups, keep: backupKeep, intervalHours: backupIntervalHours, vacuumBlocked,
    })
  })

  app.post('/api/settings/maintenance/backup', { preHandler: guard }, async (_request, reply) => {
    const { instance, dataDir, backupKeep } = app.haelan
    const file = runBackup({ db: instance.db, dir: dataDir, nowMs: app.haelan.now() })
    // Mirrors the nightly tick (maintenance/tick.ts): a backup taken by hand still counts
    // against keep, or a person clicking the button ten times in a row would grow the folder
    // without bound while the schedule's own backups stay capped.
    pruneBackups(dataDir, backupKeep)
    return reply.send(withoutPath(file))
  })

  app.post('/api/settings/maintenance/reclaim', { preHandler: guard }, async (_request, reply) => {
    const { instance, dataDir } = app.haelan
    // Always a 200: a declined vacuum is a correct outcome, not a failure, and vacuumIfBloated's
    // own return type already says so. See its own comment for why refusing is not an exception.
    const outcome = vacuumIfBloated(instance.db, dataDir)
    return reply.send(outcome)
  })
}
