import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'
import { apiSend } from '../api/client.js'
import { useSession } from '../auth/session.js'
import { useSyncStatus, syncStatusKey } from '../data/useSyncStatus.js'

/**
 * A link can name a source this person does not have, and a source can be removed after a link
 * was made. Both land here, and both should read as the merged view rather than as a select with
 * no matching option. Kept as a standalone function rather than inlined in the render: a real
 * browser select silently defaults an unmatched controlled value to whichever option renders
 * first, which is always merged here, so a test that only reads the mounted select back cannot
 * tell that fallback apart from having none at all. This is what a direct test can.
 */
export function resolveSource(source: string, options: string[]): string {
  return options.includes(source) ? source : 'merged'
}

export function ControlRow({ controls, sources, syncedMinutesAgo, exportPath }: {
  controls: PageControlsState
  sources: string[]
  syncedMinutesAgo: number
  // Optional rather than required: Sleep.tsx (still fixture backed) has no real range to build one
  // from yet and renders the download link with no href, same as a page with no export to offer.
  exportPath?: string
}) {
  const { t } = useTranslation()
  const options = ['merged', ...sources]
  const selected = resolveSource(controls.source, options)

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
        <span className="stepper-label">{controls.from === controls.to ? controls.from : `${controls.from} to ${controls.to}`}</span>
        <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}
          onClick={() => controls.step(1)}><Icon name="chevronRight" /></button>
        <input type="date" className="date-picker" aria-label={t('controlRow.pickDate')}
          value={controls.anchor} onChange={(e) => controls.setAnchor(e.currentTarget.value)} />
      </div>

      <div className="controls-end">
        <label className="button">
          <Icon name="sources" />
          <span className="sr-only">{t('controlRow.sources')}</span>
          <select value={selected} onChange={(e) => controls.setSource(e.currentTarget.value)}>
            {options.map((source) => (
              <option key={source} value={source}>
                {source === 'merged' ? t('controlRow.sourceMerged') : source}
              </option>
            ))}
          </select>
        </label>
        {/* A link, not a fetch: the export route answers a file and the browser already knows how
            to save one, so there is no blob and no object URL for this component to manage. */}
        <a className="button" href={exportPath}><Icon name="download" />{t('controlRow.downloadRaw')}</a>
        {/* personId === undefined guards the same race useSeries and useSyncStatus guard with
            their own `enabled` checks: a click before the session resolves would still post
            (apiSend needs no personId), but onSuccess's invalidation is keyed on personId and
            silently does nothing without it, leaving the status stale with no retry. Disabling
            here means that request is never sent in the first place. */}
        <button type="button" className="button button-primary"
          disabled={personId === undefined || runSync.isPending || status.data?.running === true}
          onClick={() => runSync.mutate()}>
          <Icon name="sync" />{t('controlRow.sync')}
        </button>
        <span className="synced">{t('controlRow.syncedAgo', { count: syncedMinutesAgo })}</span>
      </div>
    </div>
  )
}
