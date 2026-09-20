import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { apiSend, ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { useSyncStatus, syncStatusKey } from '../data/useSyncStatus.js'
import { useHistoryStart } from '../data/useHistoryStart.js'

/**
 * Kicking off a sync, and saying how fresh the data is.
 *
 * This lived in ControlRow until M10, beside the range and the source picker, and it did not
 * belong there. A sync is an instance-wide action: it has nothing to do with which page you are
 * on or which month you are looking at, yet it rendered on all seven pages that carry a control
 * row and wore `button-primary` - the loudest style this app has - on every one of them. The
 * result was that the noisiest control on a phone was the one a reader needs least, sitting above
 * the first number they came for.
 *
 * So it renders once, in the shell: the rail's foot on a desktop, the drawer's top bar on a
 * phone. Shell.tsx owns the element and hands it down, which also keeps the query hooks below out
 * of Sidebar and RailDrawer - both are rendered by several tests with no QueryClientProvider
 * above them, and a hook in there would put a client behind every one of those.
 */
export function SyncControl({ compact = false }: {
  /**
   * True in the phone drawer's top bar, where the freshness sits beside a hamburger and a
   * wordmark and has room for about three characters. The full sentence is still on the button's
   * title and in the screen reader's label either way; what changes here is only how much of it
   * is printed.
   */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  const status = useSyncStatus()

  // Minutes ago, not a timestamp, because syncedAgo's own message reads "Synced N min ago". Null
  // rather than zero when no run has ever finished, which is a different sentence below: a fresh
  // instance reporting "Synced 0 min ago" reads as seconds ago and is simply false.
  //
  // Computed here rather than passed in. Until M10 this identical expression appeared in all
  // seven pages that render a control row, every copy reading the same query and reaching the
  // same answer; there was never a page-specific version of it to preserve.
  const syncedMinutesAgo = status.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - status.data.lastFinishedAtMs) / 60_000))
    : null

  // tryStart on the server takes the mutex synchronously and answers before the run finishes
  // (routes/sync.ts, runner.ts's tryStart), so this mutation's own pending state is only the
  // moment of that one request, not the run it kicks off. status.data?.running, refreshed by the
  // invalidation below, is what actually disables the button for the run's whole duration.
  const runSync = useMutation({
    mutationFn: () => apiSend('POST', '/api/sync/run'),
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: syncStatusKey(personId) })
    },
  })

  // When this person's phone last delivered anything, and whether they are on the phone path at
  // all. Both come off the cursors query the range clamp already runs, so this costs no request.
  const phone = useHistoryStart()
  const phoneMinutesAgo = phone.data?.lastIngestAtMs != null
    ? Math.max(0, Math.round((Date.now() - phone.data.lastIngestAtMs) / 60_000))
    : null

  // A person whose data arrives from a phone and who has connected no Google account. The sync
  // runner never runs for them, so lastFinishedAtMs is null forever and the sentence below would
  // read "never synced" while their phone had been uploading all week. Both halves are required:
  // no Google connection alone is also a person who has connected nothing yet, and "never synced"
  // is the true answer for them.
  const phoneOnly = phone.data?.googleConnected === false && phoneMinutesAgo !== null

  // Three different states, three different sentences. The status query answering nothing yet is
  // not the same as an instance that has never finished a run, and neither is a real time.
  const syncedLabel = status.data === undefined
    ? t('sync.statusUnknown')
    : syncedMinutesAgo === null
      ? t('sync.never')
      : t('sync.ago', { count: syncedMinutesAgo })

  // The same three states at three characters. Only ever printed beside the full sentence's own
  // title attribute, never instead of it with nothing to expand into.
  const shortLabel = status.data === undefined
    ? t('sync.statusUnknownShort')
    : syncedMinutesAgo === null
      ? t('sync.neverShort')
      : t('sync.agoShort', { count: syncedMinutesAgo })

  // /api/sync/run answers 409 for both a run already going and the instance shutting down, kind
  // 'transient' either way, so the status is what tells this apart from every other error rather
  // than the kind. Without this a refused click did nothing and said nothing.
  const syncErrorLabel = runSync.error instanceof ApiError && runSync.error.status === 409
    ? t('sync.alreadyRunning')
    : t('sync.failed')

  return (
    <div className="sync-control">
      {/* An icon button rather than a labelled one, and deliberately not button-primary. There is
          one accent-filled control per view at most, and a housekeeping action that runs itself on
          a schedule is not the thing a reader came to this page to press.

          The status rides on the title rather than only in the text beside it, so the compact
          phone spelling and the collapsed rail - where CSS hides that text entirely - both still
          have somewhere to say the whole sentence. aria-label carries both halves for the same
          reason: a screen reader on a collapsed rail would otherwise hear "Sync" and no status. */}
      {/* No button on the phone path. It posts /api/sync/run, which starts the Google sync runner,
          and for somebody with no Google account that run has nothing to fetch: the click appears
          to succeed and changes nothing. Hidden rather than disabled because there is no state in
          which it would become pressable for them, and a disabled control invites a reader to work
          out what would enable it. What replaces it is the sentence beside it, which says where
          their data does come from. */}
      {!phoneOnly && (
        <button type="button" className="icon-button sync-button" title={syncedLabel}
          aria-label={`${t('sync.run')} ${syncedLabel}`}
          disabled={personId === undefined || runSync.isPending || status.data?.running === true}
          onClick={() => runSync.mutate()}>
          <Icon name="sync" />
        </button>
      )}
      {!phoneOnly && <span className="synced" aria-hidden="true">{compact ? shortLabel : syncedLabel}</span>}
      {/* Its own line rather than folded into the one above, because the two can stall
          independently: a mixed household's Google sync can be healthy while the phone has been
          asleep for a week, and one sentence carrying the newer of the two would hide exactly that.
          Not aria-hidden, unlike its neighbour: that one is spoken through the button's own
          aria-label, and with no button here this is the only thing that would say it. */}
      {phoneMinutesAgo !== null && (
        <span className="synced">
          {compact ? t('sync.phoneAgoShort', { count: phoneMinutesAgo }) : t('sync.phoneAgo', { count: phoneMinutesAgo })}
        </span>
      )}
      {runSync.isError && <span className="field-error" role="alert">{syncErrorLabel}</span>}
    </div>
  )
}
