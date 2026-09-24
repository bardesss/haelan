import type { FastifyInstance } from 'fastify'
import { COMPANION_SOURCE, composeStatus, localDateInZone, readSourceActivity } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'

/**
 * The status panel's one read. Flat surface beside /api/sync/status, and for the same reason: it
 * answers for the caller's own person, resolved from the session, never from a path segment.
 *
 * google.state's three non-'connected' branches read in the order they can each occur: an
 * unreadable row is checked first, and then a revoked one - by hasRevokedRow, not by
 * getRefreshToken()?.revokedAtMs. Both isCredentialsUnreadable and isConnected answer false the
 * moment a row's revokedAtMs is set, before either attempts to decrypt, so a row that is both
 * revoked AND undecryptable (a revoked grant, then a backup restored without instance.key) would
 * reach getRefreshToken here - which decrypts and throws CredentialsUnreadableError on exactly
 * that row. This route sits outside registerV1's error handler, so that throw would surface as
 * an unhandled 500 rather than the 'revoked' state this person actually has (a review round
 * found this the hard way - see task-5-report.md's fix entry). hasRevokedRow reads only the
 * column and never decrypts, which is what makes it safe to call before isCredentialsUnreadable
 * has ruled anything out. See CredentialStore's own comments on isConnected,
 * isCredentialsUnreadable and hasRevokedRow for why the three are separate methods.
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
        : credentials.hasRevokedRow(personId) ? 'revoked' as const
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
