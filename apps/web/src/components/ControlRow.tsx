import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'
import { apiSend, ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { useSyncStatus, syncStatusKey } from '../data/useSyncStatus.js'
import { ALL_SOURCES } from '../controls/source.js'

export function ControlRow({ controls, sources, syncedMinutesAgo, exportPath, canSync = true }: {
  controls: PageControlsState
  sources: string[]
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
  const { t } = useTranslation()
  // Shown exactly as handed over. controls.source has already been resolved against this same
  // list in the state layer (controls/source.ts), so the label here and the source the page is
  // querying under cannot drift apart: they are one value.
  const options = [ALL_SOURCES, ...sources]

  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  const status = useSyncStatus()
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

  // /api/sync/run answers 409 when a run is already going, which apiSend maps to the
  // setup_incomplete kind along with every other 409 on the surface, so the status is what tells
  // the two apart. Without this a refused click did nothing and said nothing.
  const syncErrorLabel = runSync.error instanceof ApiError && runSync.error.status === 409
    ? t('controlRow.syncAlreadyRunning')
    : t('controlRow.syncFailed')

  return (
    <div className="controls">
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
        <span className="stepper-label">
          {controls.from === controls.to ? controls.from : `${controls.from} ${t('common.to')} ${controls.to}`}
        </span>
        <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}
          onClick={() => controls.step(1)}><Icon name="chevronRight" /></button>
        <input type="date" className="date-picker" aria-label={t('controlRow.pickDate')}
          value={controls.anchor} onChange={(e) => controls.setAnchor(e.currentTarget.value)} />
      </div>

      <div className="controls-end">
        <label className="button">
          <Icon name="sources" />
          <span className="sr-only">{t('controlRow.sources')}</span>
          <select value={controls.source} onChange={(e) => controls.setSource(e.currentTarget.value)}>
            {options.map((source) => (
              <option key={source} value={source}>
                {source === ALL_SOURCES ? t('controlRow.sourceAll') : source}
              </option>
            ))}
          </select>
        </label>
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
    </div>
  )
}
