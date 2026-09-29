import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow, FigureRows } from '../../../components/FigureRow.js'
import type { FigureRowStrip } from '../../../components/FigureRow.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine, workoutStripOf } from '../../detail/figureText.js'

// The four figures under the hero, in the mockup's order.
const MINIS = ['distance', 'movingTime', 'averageHeartRate', 'cardioLoad'] as const

/**
 * Distance, moving time, average heart rate and cardio load, each with its value, a line of this
 * workout and up to nine of its type before it over the usual for the type, and the server's verdict
 * in words - the night page's NightMinis, for a workout.
 *
 * A figure the workout has no reading for is left out (the payload has no entry for it at all),
 * and so is the one the hero already leads with: a strength session's moving time is its hero, and
 * the same figure twice in a row says nothing new. With none left the card goes too, so the grid
 * closes up; with fewer than four, each takes its share of the card (FigureRows). The rows are memoised on the payload, since each strip's arrays and formatter reach
 * the chart it draws, and a fresh one every render would rebuild it.
 */
export function WorkoutMinis({ page }: { page: WorkoutPageData }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { figures, hero } = page
  const rows = useMemo(() => MINIS.flatMap((key) => {
    const figure = figures[key]
    if (figure === undefined || figure.value === null || key === hero) return []
    const label = t(`activity.workout.page.figures.${key}`)
    const drawn = workoutStripOf(figure)
    const strip: FigureRowStrip | undefined = drawn === null ? undefined : {
      ...drawn, metric: figure.metric, unit: label,
      formatValue: (value, absent) => (value === null ? absent : formatFigureValue(figure, value, language, t)),
    }
    return [{
      key, label, strip, figure,
      value: formatFigureValue(figure, figure.value, language, t),
      verdict: verdictLine(figure, language, t) ?? t('glance.usual.none'),
    }]
  }), [figures, hero, language, t])
  if (rows.length === 0) return null
  // What the lines are, counted off the strips themselves (the longest, since a figure a session
  // did not record has fewer points), and the band named only when one is drawn.
  const drawn = rows.flatMap(({ strip }) => (strip === undefined ? [] : [strip]))
  const earlier = Math.max(0, ...drawn.map((strip) => strip.values.length - 1))
  const caption = [
    t('activity.workout.page.minisCaption', { count: earlier }),
    ...(drawn.some((strip) => strip.bands !== undefined) ? [t('activity.workout.page.stripBand')] : []),
  ].join(' · ')

  return (
    <Card span={12}>
      <div className="detail-minis">
        <FigureRows>
          {rows.map(({ key, label, value, verdict, figure, strip }) => (
            <FigureRow key={key} label={label} value={value} verdict={verdict} judged={figure.judged} standing={figure.standing}
              band={figure.baseline} mark={figure.value} strip={strip} />
          ))}
        </FigureRows>
        {drawn.length > 0 && <p className="dash-caption">{caption}</p>}
      </div>
    </Card>
  )
}
