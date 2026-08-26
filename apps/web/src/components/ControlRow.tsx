import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'

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
  // Unread until Task 12 wires the download button to it. Declared now so that landing it later
  // is not a breaking change to every call site and every test written against this shape.
  exportPath?: string
}) {
  const { t } = useTranslation()
  const options = ['merged', ...sources]
  const selected = resolveSource(controls.source, options)

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
          <span className="visually-hidden">{t('controlRow.sources')}</span>
          <select value={selected} onChange={(e) => controls.setSource(e.currentTarget.value)}>
            {options.map((source) => (
              <option key={source} value={source}>
                {source === 'merged' ? t('controlRow.sourceMerged') : source}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button"><Icon name="download" />{t('controlRow.downloadRaw')}</button>
        <button type="button" className="button button-primary"><Icon name="sync" />{t('controlRow.sync')}</button>
        <span className="synced">{t('controlRow.syncedAgo', { count: syncedMinutesAgo })}</span>
      </div>
    </div>
  )
}
