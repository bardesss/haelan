import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { ActivityHeatmap } from '../../../charts/ActivityHeatmap.js'
import type { DayRow } from '../../../fixtures/july.js'
import type { PeriodFigure, PeriodHigh, PeriodRange } from '../../../data/periodTypes.js'
import { thisPeriod } from '../../detail/periodText.js'

/** The ranges the heatmap is drawn on: those whose hero strip is weekly, so a day has nowhere else. */
export function drawsHeatmap(range: PeriodRange): boolean {
  return range === '3months' || range === 'year'
}

/**
 * "Stappen per dag", on 3 months and Year only: every day of the period as a square, coloured by
 * its steps (the hero's own daily points, which the server keeps on these ranges for this) on a
 * scale up to the server's busiest day (`high`), a day with none marked as absent, and the busiest
 * day ringed and ✦ when the server judged it good, which the caption then names. A square opens
 * that day on the dashboard (`onOpenDay`), where its figures are.
 */
export function ActivityHeatmapCard({ steps, high, range, onOpenDay }: {
  steps: PeriodFigure
  high: PeriodHigh | null
  range: PeriodRange
  onOpenDay: (localDate: string) => void
}) {
  const { t } = useTranslation()
  const days = useMemo<DayRow[]>(() => steps.daily.map((point) => ({
    date: point.from, steps: point.value, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: point.value !== null,
  })), [steps])
  if (!drawsHeatmap(range) || !days.some((day) => day.steps !== null)) return null

  const label = t('activity.period.heatmap.label')
  return (
    <Card span={12} label={label}>
      <ActivityHeatmap days={days} max={high?.value ?? 0} label={label} good={high?.good === true ? high.localDate : null} onPointClick={onOpenDay} />
      <p className="dash-caption">
        {t(high?.good === true ? 'activity.period.heatmap.captionGood' : 'activity.period.heatmap.caption', { period: thisPeriod(range, t) })}
      </p>
    </Card>
  )
}
