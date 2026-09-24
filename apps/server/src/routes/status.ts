import type { FastifyInstance } from 'fastify'
import { COMPANION_SOURCE, composeStatus, localDateInZone, readSourceActivity } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'

/**
 * The status panel's one read. Flat surface beside /api/sync/status, and for the same reason: it
 * answers for the caller's own person, resolved from the session, never from a path segment.
 *
 * google.state's three non-'connected' branches read in the order they can each occur: an
 * unreadable row is checked first because CredentialStore.isConnected and getRefreshToken cannot
 * be trusted to answer it (both treat a row that fails to decrypt the same as one that answers
 * false / null), and once that branch has ruled a row unreadable out, the rest of this function
 * never calls getRefreshToken on a row it has not already proven readable: isConnected already
 * decrypted it once (successfully, to get past the first check), so getRefreshToken's own
 * decrypt cannot throw here. See CredentialStore's own comments on isConnected and
 * isCredentialsUnreadable for why the two checks are separate methods rather than one.
 */
export function registerStatus(app: FastifyInstance): void {
  app.get('/api/status', { preHandler: [app.requireSession] }, async (request, reply) => {
    const account = request.accountId ? app.haelan.stores.accounts.getById(request.accountId) : null
    if (!account) return reply.code(401).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    const personId = account.personId
    const { instance, stores, runner } = app.haelan
    const nowMs = app.haelan.now()
    const person = stores.people.get(personId)
    const today = localDateInZone(nowMs, person?.timezone ?? 'UTC')

    const credentials = stores.credentials
    const google = credentials.isCredentialsUnreadable(personId) ? 'credentials_unreadable' as const
      : credentials.isConnected(personId) ? 'connected' as const
        : credentials.getRefreshToken(personId)?.revokedAtMs != null ? 'revoked' as const
          : 'none' as const

    // Every companion row this person has archived carries the source it resolved to
    // (requestParams.dataSource, a source id - see routes/v1/ingest.ts), which is how the phone's
    // devices are told apart from Google's without a column anywhere recording which connection a
    // row came through. listForSource's own select list carries no bodyGzip, so this pays only
    // for the small archive-metadata columns, the same cost /companion/cursors already pays for
    // the same rows.
    let lastUploadAtMs: number | null = null
    const phoneSources = new Set<string>()
    for (const row of stores.archive.listForSource(personId, COMPANION_SOURCE)) {
      if (lastUploadAtMs === null || row.fetchedAtMs > lastUploadAtMs) lastUploadAtMs = row.fetchedAtMs
      const params = JSON.parse(row.requestParams) as { dataSource?: unknown }
      if (typeof params.dataSource === 'string') phoneSources.add(params.dataSource)
    }

    const run = runner.runState()
    return composeStatus({
      today,
      nowMs,
      google: { state: google },
      run: {
        running: run.running,
        lastFinishedAtMs: run.lastFinishedAtMs,
        lastRowsWritten: run.lastRowsWritten,
        lastFailed: run.lastFailed,
        cooldownRemainingMs: run.cooldownRemainingMs,
      },
      phone: { lastUploadAtMs, sourceIds: phoneSources },
      activity: readSourceActivity(instance.db, personId, { today }),
      names: new Map(instance.sourceAliases.listNamed(personId).map((s) => [s.id, s.name])),
      choices: instance.sourceVisibility.list(personId),
    })
  })
}
