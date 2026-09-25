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
    // row came through. This route is polled every three seconds while a run is going, so it asks
    // SQLite for one row per data source (lastFetchedByDataSource) rather than walking every
    // companion row and parsing each one's JSON here, which is what it did first: a phone that has
    // synced for a year is tens of thousands of rows, read in full to produce a handful of ids.
    // The null group is an upload that named no source - it still counts towards the upload time.
    let lastUploadAtMs: number | null = null
    const phoneSources = new Set<string>()
    for (const row of stores.archive.lastFetchedByDataSource(personId, COMPANION_SOURCE)) {
      if (lastUploadAtMs === null || row.lastFetchedAtMs > lastUploadAtMs) lastUploadAtMs = row.lastFetchedAtMs
      if (typeof row.dataSource === 'string') phoneSources.add(row.dataSource)
    }

    const run = runner.runState()
    // run.lastFailed is instance-wide - the last run's failure count across everyone it synced -
    // so passing it straight through would mark this person's row 'sync_failed' because a
    // housemate's sync failed, not their own. freshnessFor's own failing count is per person.
    //
    // The list is what "Part of the last sync failed" was missing: which types, and why. It is
    // the same set that count is taken over (failuresFor is built on the same dueJobs rule and the
    // same consecutiveFailures test, and its store test pins the two to agree), so its length is
    // the count and a second query would only be a chance for them to disagree.
    const syncFailures = stores.syncState.failuresFor(personId)
    const failing = syncFailures.length
    // Read once for both maps: the default names depend on the whole list (two Health Connect
    // rows are told apart by date), so the two maps must come from the same read.
    const named = instance.sourceAliases.listNamed(personId)
    return composeStatus({
      today,
      nowMs,
      google: { state: google },
      run: {
        running: run.running,
        lastFinishedAtMs: run.lastFinishedAtMs,
        lastRowsWritten: run.lastRowsWritten,
        lastFailed: run.lastFailed === null ? null : failing,
        cooldownRemainingMs: run.cooldownRemainingMs,
      },
      phone: { lastUploadAtMs, sourceIds: phoneSources },
      activity: readSourceActivity(instance.db, personId, { today }),
      names: new Map(named.map((s) => [s.id, s.name])),
      // Null beside an alias: a panel row carries no alias to check first, so it must not be
      // handed a default that would outrank the name the person chose.
      defaultNames: new Map(named.map((s) => [s.id, s.alias === null ? s.defaultName : null])),
      choices: instance.sourceVisibility.list(personId),
      syncFailures,
    })
  })
}
