import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'
import { apiSend, ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { useSyncStatus, syncStatusKey } from '../data/useSyncStatus.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { ALL_SOURCES } from '../controls/source.js'
import { periodLabel } from '../controls/periodLabel.js'
import { RebuildNotice } from './RebuildNotice.js'

// A frozen module constant, not a fresh `[]` default: a new array identity on every render is
// what chart-lifecycle.test.tsx exists to catch elsewhere in this app, and a default parameter
// expression runs on every call.
const EMPTY_SOURCES: string[] = Object.freeze([]) as never[]

// Built per language and cached by Intl itself. "Watch and scale" in English, "Watch en scale" in
// Dutch, and neither spelling hardcoded here.
const listFormat = (language: string): Intl.ListFormat =>
  new Intl.ListFormat(language, { style: 'long', type: 'conjunction' })

export function ControlRow({
  controls, sources, syncedMinutesAgo, exportPath, canSync = true, stoppedSources = EMPTY_SOURCES,
}: {
  controls: PageControlsState
  sources: string[]
  /**
   * Sources that fed this range and then went quiet inside it, from
   * `sourcesStoppedInRange` (data/pageShell.ts). Defaulted, so a page that has not adopted it
   * renders exactly as it did before rather than being forced to pass an empty array.
   *
   * Passed in rather than computed here: this component has no series, and the question is about
   * the points a page has already loaded.
   */
  stoppedSources?: string[]
  // null when no run has ever finished. It used to be a plain number, and nothing synced yet was
  // reported as 0, so a fresh instance and a page still loading both read "Synced 0 min ago",
  // which a reader takes to mean seconds ago. A missing copy string is not a reason to print a
  // false one.
  syncedMinutesAgo: number | null
  // Optional rather than required: a page with no range of its own has no export to offer, and
  // the link is left out rather than rendered with no href.
  exportPath?: string
  // False on a page that cannot honour a sync: the button really posts and the label really
  // claims a time, so offering either from a page pinned to fixtures is a control that lies.
  canSync?: boolean
}) {
  const { t, i18n } = useTranslation()
  // Shown exactly as handed over. controls.source has already been resolved against this same
  // list in the state layer (controls/source.ts), so the label here and the source the page is
  // querying under cannot drift apart: they are one value.
  const options = [ALL_SOURCES, ...sources]
  // Notes hands this component `sources={[]}` on purpose (Notes.tsx's own doc comment: a note or
  // an event is not read off a device the way a metric sample is), which used to still draw a
  // select holding one option, "All sources", choosing between nothing. A picker of one choice is
  // not a picker.
  const hasSourcePicker = sources.length > 0

  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  const status = useSyncStatus()
  const { nameOf } = useSourceNames()
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

  // Three different states, three different sentences. The status query answering nothing yet is
  // not the same as an instance that has never finished a run, and neither is a real time.
  const syncedLabel = status.data === undefined
    ? t('controlRow.syncUnknown')
    : syncedMinutesAgo === null
      ? t('controlRow.neverSynced')
      : t('controlRow.syncedAgo', { count: syncedMinutesAgo })

  // /api/sync/run answers 409 for both a run already going and the instance shutting down, kind
  // 'transient' either way, so the status is what tells this apart from every other error rather
  // than the kind. Without this a refused click did nothing and said nothing.
  const syncErrorLabel = runSync.error instanceof ApiError && runSync.error.status === 409
    ? t('controlRow.syncAlreadyRunning')
    : t('controlRow.syncFailed')

  return (
    <div className="controls">
      {/* Guarded on status.data rather than left to RebuildNotice's own null return: the query
          answers nothing for a moment after mount (the same gap syncedLabel's own three-way
          branch above exists for), and status.data.rebuild does not exist yet in that instant --
          rendering the row's other controls immediately while this waits one tick behind them.
          SyncStatus.rebuild is a required field: a real response always carries it (runner.ts's
          own status()), so once status.data exists, trusting its shape rather than re-checking
          the field itself is what keeps a future malformed or legacy answer from reading as
          "nothing to report" instead of failing where it can be seen. */}
      {/* rebuildInFlight is passed by name rather than arriving in the spread: it is not in
          status.data.rebuild, because it is one fact about the server process and that object
          carries facts about this person's own data. The spread would silently stop supplying it
          if it ever moved, which the required prop on RebuildNotice is what catches. */}
      {status.data !== undefined && (
        <RebuildNotice
          voice="self" rebuildInFlight={status.data.rebuildInFlight} {...status.data.rebuild}
        />
      )}
      <div className="segmented" role="group" aria-label={t('controlRow.timeRangeLabel')}>
        {RANGE_KEYS.map((key) => (
          <button key={key} type="button" className="segment" aria-pressed={key === controls.tab}
            onClick={() => controls.setTab(key)}>
            {t(`controlRow.ranges.${key}`)}
          </button>
        ))}
      </div>

      <div className="stepper">
        <button type="button" className="icon-button" aria-label={t('controlRow.previousPeriod')}
          onClick={() => controls.step(-1)}><Icon name="chevronLeft" /></button>
        {/* The exact bounds move to the title rather than being dropped: the label now names the
            period ("september 2026") and a reader who wants to know which days that covers can
            hover for them. The pretty name is what a screen reader gets, which is an improvement
            on two ISO dates rather than a loss, so nothing here is sr-only. */}
        <span className="stepper-label" title={`${controls.from} ${t('common.to')} ${controls.to}`}>
          {periodLabel(controls.tab, controls.from, controls.to, i18n.language)}
        </span>
        <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}
          onClick={() => controls.step(1)}><Icon name="chevronRight" /></button>
        <input type="date" className="date-picker" aria-label={t('controlRow.pickDate')}
          value={controls.anchor} onChange={(e) => controls.setAnchor(e.currentTarget.value)} />
      </div>

      <div className="controls-end">
        {hasSourcePicker && (
          <label className="button">
            <Icon name="sources" />
            <span className="sr-only">{t('controlRow.sources')}</span>
            <select value={controls.source} onChange={(e) => controls.setSource(e.currentTarget.value)}>
              {options.map((source) => (
                <option key={source} value={source}>
                  {source === ALL_SOURCES ? t('controlRow.sourceAll') : nameOf(source)}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* A link, not a fetch: the export route answers a file and the browser already knows how
            to save one, so there is no blob and no object URL for this component to manage. Left
            out entirely without a path, rather than rendered as an anchor that goes nowhere. */}
        {exportPath !== undefined && (
          <a className="button" href={exportPath}><Icon name="download" />{t('controlRow.downloadTotals')}</a>
        )}
        {/* personId === undefined guards the same race useSeries and useSyncStatus guard with
            their own `enabled` checks: a click before the session resolves would still post
            (apiSend needs no personId), but onSuccess's invalidation is keyed on personId and
            silently does nothing without it, leaving the status stale with no retry. Disabling
            here means that request is never sent in the first place. */}
        {canSync && (
          <button type="button" className="button button-primary"
            disabled={personId === undefined || runSync.isPending || status.data?.running === true}
            onClick={() => runSync.mutate()}>
            <Icon name="sync" />{t('controlRow.sync')}
          </button>
        )}
        {canSync && <span className="synced">{syncedLabel}</span>}
        {canSync && runSync.isError && <span className="field-error">{syncErrorLabel}</span>}
      </div>
      {/* The answer to what a thinning chart actually raises: did the person do less, or did the
          device stop. Said once for the page rather than on each card, because every card on a
          page reads the same range and would otherwise repeat one sentence up to twelve times.
          Named, because "a source stopped" sends the reader to Settings to find out which.

          The names never begin the sentence, which is why the copy reads "Stopped reporting
          during this range: X" rather than "X stopped reporting". A source is called whatever
          its device or its owner called it - "com.lyfta", "My watch" - so a sentence-initial
          name either renders lowercase mid-sentence or gets capitalised into something nobody
          typed. */}
      {stoppedSources.length > 0 && (
        <p className="control-row-stopped">
          {t('controlRow.sourceStopped', {
            sources: listFormat(i18n.language).format(stoppedSources.map(nameOf)),
            count: stoppedSources.length,
          })}
        </p>
      )}
    </div>
  )
}
