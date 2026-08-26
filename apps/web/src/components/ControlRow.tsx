import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { RangeKey } from '../controls/range.js'

export function ControlRow({ range, label, sources, syncedMinutesAgo }: {
  range: RangeKey
  label: string
  sources: string
  syncedMinutesAgo: number
}) {
  const { t } = useTranslation()
  return (
    <div className="controls">
      <div className="segmented" role="group" aria-label={t('controlRow.timeRangeLabel')}>
        {RANGE_KEYS.map((key) => (
          <button key={key} type="button" className="segment" aria-pressed={key === range}>
            {t(`controlRow.ranges.${key}`)}
          </button>
        ))}
      </div>

      <div className="stepper">
        <button type="button" className="icon-button" aria-label={t('controlRow.previousPeriod')}><Icon name="chevronLeft" /></button>
        <span className="stepper-label">{label}</span>
        <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}><Icon name="chevronRight" /></button>
      </div>

      <div className="controls-end">
        <button type="button" className="button">
          <Icon name="sources" />{t('controlRow.sources')}<span className="button-count">{sources}</span>
        </button>
        <button type="button" className="button"><Icon name="download" />{t('controlRow.downloadRaw')}</button>
        <button type="button" className="button button-primary"><Icon name="sync" />{t('controlRow.sync')}</button>
        <span className="synced">{t('controlRow.syncedAgo', { count: syncedMinutesAgo })}</span>
      </div>
    </div>
  )
}
