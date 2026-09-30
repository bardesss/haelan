import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow, verdictTone } from '../../../components/FigureRow.js'
import { Icon } from '../../../components/icons.js'
import type { PeriodFigure, PeriodRange, TypeTotal, Vo2Trend } from '../../../data/periodTypes.js'
import { exerciseTypeLabel } from '../../../data/exerciseTypeLabel.js'
import { exerciseCategory } from '../../../data/exerciseCategory.js'
import { formatNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { verdictLine } from '../../detail/figureText.js'
import { monthName } from '../../detail/periodText.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { CATEGORY_ICONS } from '../SessionRow.js'
import { minutesText, useActivityLabel } from './labels.js'

const NBSP = ' '
const SEPARATOR = ' · '

/** Whether the card has anything to show: a type, a cardio load or a VO₂max. */
export function hasTypes(types: TypeTotal[], cardioLoad: PeriodFigure | null, vo2max: Vo2Trend | null): boolean {
  return types.length > 0 || (cardioLoad !== null && cardioLoad.value !== null) || vo2max !== null
}

/**
 * A type's count against its usual count for a period this long, in the verdict catalogue's words
 * ("above your usual 3 – 4"), or "no usual yet" without one. Nothing where the server did not
 * judge it (a running period, or a thin usual). The server judges more of a type than usual the
 * better side (`judged`), so above reads green and below red (verdictTone), the approved mockup's.
 */
function typeVerdict(type: TypeTotal, language: string, t: Translate): string | null {
  if (type.usualCount === null) return t('glance.usual.none')
  if (type.usualCount.thin || type.standing === null) return null
  return verdictLine({
    metric: 'workout_count', unit: 'count', precision: 0, direction: 'neutral', judged: null,
    value: type.count, baseline: type.usualCount, standing: type.standing,
  }, language, t)
}

// "5 × · 32.4 km", or the type's time where it has no distance ("1 × · 54 min").
function typeAmount(type: TypeTotal, language: string, t: Translate): string {
  const absent = t('common.absent')
  const amount = type.distanceMeters !== null
    ? `${formatNumber(type.distanceMeters / 1000, 1, language, absent)}${NBSP}${t('activity.units.km')}`
    : minutesText(type.seconds / 60, language, t)
  return `${t('activity.period.types.times', { count: type.count }).replace(' ', NBSP)}${SEPARATOR}${amount}`
}

/**
 * The VO₂max's trend in words, after its latest value ("rising · was 40 in May", "steady at 42"),
 * the server's `trend` against the reading about three months before; null with no trend, so the
 * row draws no verdict line at all.
 */
function vo2Words(vo2: Vo2Trend, language: string, t: Translate): string | null {
  const value = (n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 1, language, t('common.absent'))
  if (vo2.trend === null) return null
  if (vo2.trend === 'steady' || vo2.earlier === null || vo2.earlierDate === null) return t('activity.period.vo2.steady', { latest: value(vo2.latest) })
  return t(`activity.period.vo2.${vo2.trend}`, { earlier: value(vo2.earlier), month: monthName(vo2.earlierDate, language) })
}

/**
 * "Per soort": one row per type the period's counted workouts hold (the server's `types`), its
 * icon and name, its count and distance (or time) on the right, and under the name its count
 * against the usual count for a period this long. Then the cardio load as a figure row, its
 * average against its usual, and the VO₂max's latest value with its trend, named by the reading
 * that supplied it.
 */
export function ActivityTypes({ types, cardioLoad, vo2max, range, span }: {
  types: TypeTotal[]
  cardioLoad: PeriodFigure | null
  vo2max: Vo2Trend | null
  range: PeriodRange
  span: number
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const labelOf = useActivityLabel()
  // Memoised: the rows memoise on it, and a fresh array every render would rebuild the strip's chart.
  const figures = useMemo(() => (cardioLoad === null ? [] : [cardioLoad]), [cardioLoad])
  return (
    <Card span={span} label={t('activity.period.types.label')}>
      {types.length > 0 && (
        <>
          <p className="dash-caption">{t(`activity.period.types.caption.${range}`)}</p>
          <ul className="activity-types">
            {types.map((type) => {
              const verdict = typeVerdict(type, language, t)
              const tone = type.usualCount === null ? null : verdictTone(type.judged, type.standing)
              const category = exerciseCategory(type.type)
              return (
                <li key={type.type ?? ''} className="activity-type">
                  <span className="session-row-icon" data-category={category}><Icon name={CATEGORY_ICONS[category]} /></span>
                  <span className="activity-type-name">{exerciseTypeLabel(t, type.type)}</span>
                  <span className="activity-type-amount">{typeAmount(type, language, t)}</span>
                  {verdict !== null && <span className={tone === null ? 'activity-type-verdict' : `activity-type-verdict ${tone}`}>{verdict}</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="day" max={2}>
        {vo2max !== null && (
          <FigureRow label={t('activity.workout.page.figures.vo2max')}
            value={formatNumber(vo2max.latest, Number.isInteger(vo2max.latest) ? 0 : 1, language, t('common.absent'))}
            verdict={vo2Words(vo2max, language, t)} judged={null} band={null} mark={null}
            note={t(`dataTypes.${vo2max.metric.replaceAll('_', '-')}`)} />
        )}
      </PeriodFigureRows>
    </Card>
  )
}
