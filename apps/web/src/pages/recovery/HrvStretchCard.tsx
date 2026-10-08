import { useId, useMemo } from 'react'
import { METRICS } from '@haelan/core/metrics'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { valueParts, verdictTone } from '../../components/FigureRow.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { PointJudged, PointStanding } from '../../charts/base.js'
import type { HrvDeviationDay, RecoveryMethod, RecoveryStretch } from '../../data/periodTypes.js'
import { formatFigureValue } from '../detail/figureText.js'

// The HRV the stretch is worked out on, for its unit and precision: the catalogue's, so the card
// prints a reading the way the HRV figure row above it does.
const HRV = { metric: 'daily_hrv', unit: METRICS.daily_hrv!.unit, precision: METRICS.daily_hrv!.precision, value: null }

interface StretchPoint { from: string, to: string, day: HrvDeviationDay | null }

/** The strip's points: each day on Week and Month, each week (its last measured day) on 3 months and Year. */
function pointsOf(stretch: RecoveryStretch): StretchPoint[] {
  return stretch.weeks !== null
    ? stretch.weeks.map((week) => ({ from: week.from, to: week.to, day: week.point }))
    : stretch.days.map((day) => ({ from: day.localDate, to: day.localDate, day }))
}

/**
 * Each run as the first and last index of the points it touches (a run's days overlapping a
 * point's), so on 3 months and Year a run shades every week it reaches into. A run touching no
 * point shades nothing.
 */
function spansOf(stretch: RecoveryStretch, points: readonly StretchPoint[]): { from: number, to: number }[] {
  const spans: { from: number, to: number }[] = []
  for (const run of stretch.runs) {
    let from = -1
    let to = -1
    points.forEach((point, index) => {
      if (point.from > run.to || point.to < run.from) return
      if (from < 0) from = index
      to = index
    })
    if (from >= 0) spans.push({ from, to })
  }
  return spans
}

/**
 * "HRV against its usual week" (PATTERNS.md's figure rows and the strip spans line): the 7-day
 * average as a row, its last measured value printed, a strip of it with each point's own band as a
 * step, every run inside the period shaded across the points it covers, and under it the verdict
 * the server's run as of the period's last day words. A dot carries the side the server judged it
 * on and no better or worse, so one outside its band takes the out tone (verdictTone) and one inside
 * stays plain; a dot inside a shaded span can be plain, since the server re-judges each dot after
 * rounding while a run is judged once. The verdict takes the same out tone; "within" stays plain,
 * and the note under it judges nothing.
 *
 * Nothing at all without a stretch, or with no measured point to draw. The strip's arrays are
 * memoised on the stretch: a fresh one every render would rebuild the chart.
 */
export function HrvStretchCard({ stretch, method }: { stretch: RecoveryStretch | null, method: RecoveryMethod }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const strip = useMemo(() => {
    if (stretch === null) return null
    const points = pointsOf(stretch)
    const measured = (point: StretchPoint) => (point.day !== null && point.day.measured ? point.day : null)
    return {
      values: points.map((point) => measured(point)?.rolling ?? null),
      labels: points.map((point) => point.from),
      bands: points.map((point) => measured(point)?.band ?? null),
      pointStandings: points.map((point): PointStanding => measured(point)?.side ?? null),
      pointJudged: points.map((): PointJudged => null),
      spans: spansOf(stretch, points),
      weekly: stretch.weeks !== null,
    }
  }, [stretch])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatFigureValue(HRV, value, language, t)),
    [language, t],
  )

  if (stretch === null || strip === null) return null
  const latest = [...strip.values].reverse().find((value) => value !== null)
  if (latest === undefined || latest === null) return null

  const label = t('recovery.stretch.label')
  const parts = valueParts(formatFigureValue(HRV, latest, language, t))
  const { run } = stretch
  const verdict = run === null
    ? t('recovery.stretch.within')
    : run.capped
      ? t(`recovery.stretch.capped.${run.side}`, { days: method.stretch.lookbackDays })
      : t(`recovery.stretch.run.${run.side}`, { days: run.days })
  const tone = run === null ? null : verdictTone(null, run.side)
  const caption = t(strip.weekly ? 'recovery.stretch.caption.weekly' : 'recovery.stretch.caption.daily', {
    weekDays: method.stretch.weekDays, baselineDays: method.baselineDays,
  })

  return (
    <Card span={12} label={label}>
      <div className="figure-row">
        <span className="label figure-row-label">{t('recovery.stretch.average', { days: method.stretch.weekDays })}</span>
        <span className="figure-row-value">{parts.number}{parts.unit !== null && <span className="figure-row-unit">{parts.unit}</span>}</span>
        <BasisContext.Provider value={verdictId}>
          <Sparkline values={strip.values} labels={strip.labels} label={label} unit={HRV.unit} metric={HRV.metric}
            formatValue={formatValue} bands={strip.bands} pointStandings={strip.pointStandings} pointJudged={strip.pointJudged}
            spans={strip.spans} height={64} dots tableToggle={false} />
        </BasisContext.Provider>
        <span id={verdictId} className={tone === null ? 'figure-row-verdict' : `figure-row-verdict ${tone}`}>{verdict}</span>
        {run !== null && (
          <span className="figure-row-note">
            {t(`recovery.stretch.note.${run.side}`, { sideNights: run.sideNights, weekReadings: run.weekReadings })}
          </span>
        )}
      </div>
      <p className="dash-caption">{caption}</p>
    </Card>
  )
}
