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
 * point's), so on 3 months and Year a run shades every week it reaches into, the period's clipped
 * first week included. A run touching no point shades nothing, and two runs reaching the same week
 * shade it once: the runs come oldest first, so a span that starts inside the one before it joins it.
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
    if (from < 0) continue
    const last = spans.at(-1)
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to)
    else spans.push({ from, to })
  }
  return spans
}

const measuredDay = (point: StretchPoint) => (point.day !== null && point.day.measured ? point.day : null)

/** The index of the last entry `keep` holds for, -1 with none (the es2023 array method is past the web's lib). */
function lastIndexWhere<T>(items: readonly T[], keep: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (keep(items[index]!)) return index
  return -1
}

/**
 * "HRV against its usual week" (PATTERNS.md's figure rows and the strip spans line): the 7-day
 * average as a single row across the card, its last measured value printed, a strip of it at the
 * hero's height with each point's own band as a step and the last step's edges labelled, every run
 * inside the period shaded across the points it covers, and under it the verdict.
 *
 * The verdict words the server's run as of the period's last day: its measured days, or past the
 * lookback "more than" it. Without a run it says what the last dot says: within its usual; on one
 * side for fewer days than a stretch needs; or, unmeasured, too few readings in the last week. A
 * dot carries the side the server judged it on and no better or worse, so one outside its band
 * takes the out tone (verdictTone) and one inside stays plain; a dot inside a shaded span can be
 * plain, since the server re-judges each dot after rounding while a run is judged once. A verdict
 * on one side takes the same out tone; the others stay plain, and the note under a run judges
 * nothing.
 *
 * Nothing at all without a stretch. With no measured point, only the line saying how much HRV a
 * first week needs when every point lacks a baseline, and nothing for any other reason. The strip's
 * arrays are memoised on the stretch: a fresh one every render would rebuild the chart.
 */
export function HrvStretchCard({ stretch, method }: { stretch: RecoveryStretch | null, method: RecoveryMethod }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const strip = useMemo(() => {
    if (stretch === null) return null
    const points = pointsOf(stretch)
    const bands = points.map((point) => measuredDay(point)?.band ?? null)
    const last = lastIndexWhere(bands, (band) => band !== null)
    return {
      points,
      values: points.map((point) => measuredDay(point)?.rolling ?? null),
      labels: points.map((point) => point.from),
      bands,
      // The last step, the band the edge labels name, as the hero's strip labels its latest usual.
      baseline: last < 0 ? undefined : bands[last]!,
      pointStandings: points.map((point): PointStanding => measuredDay(point)?.side ?? null),
      pointJudged: points.map((): PointJudged => null),
      spans: spansOf(stretch, points),
      weekly: stretch.weeks !== null,
    }
  }, [stretch])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatFigureValue(HRV, value, language, t)),
    [language, t],
  )
  const bandLabels = useMemo(() => strip?.baseline === undefined ? undefined : {
    low: formatFigureValue(HRV, strip.baseline.low, language, t), high: formatFigureValue(HRV, strip.baseline.high, language, t),
  }, [strip, language, t])

  if (stretch === null || strip === null) return null
  const label = t('recovery.stretch.label')
  const lastMeasured = lastIndexWhere(strip.points, (point) => measuredDay(point) !== null)

  if (lastMeasured < 0) {
    // No point measured: worth a line only when every one waits on a baseline, which is a matter of
    // time; a period with no HRV at all has nothing to say here.
    const days = strip.points.flatMap((point) => (point.day === null ? [] : [point.day]))
    const waiting = days.length > 0 && days.every((day) => !day.measured && day.reason === 'thin-baseline')
    if (!waiting) return null
    return (
      <Card span={12} label={label}>
        <div className="figure-row">
          <span className="figure-row-verdict">{t('recovery.stretch.needsBaseline', { baselineDays: method.baselineDays })}</span>
        </div>
      </Card>
    )
  }

  const parts = valueParts(formatFigureValue(HRV, strip.values[lastMeasured]!, language, t))
  const { run } = stretch
  const lastDay = strip.points.at(-1)?.day ?? null
  const lastSide = lastDay !== null && lastDay.measured ? lastDay.side : null
  const side = run?.side ?? (lastSide === 'within' ? null : lastSide)
  const verdict = run !== null
    ? run.capped
      ? t(`recovery.stretch.capped.${run.side}`, { days: method.stretch.lookbackDays })
      : t(`recovery.stretch.run.${run.side}`, { days: run.days })
    : lastSide === null
      ? t('recovery.stretch.tooFew', { weekDays: method.stretch.weekDays })
      : lastSide === 'within'
        ? t('recovery.stretch.within')
        : t(`recovery.stretch.short.${lastSide}`, { minRun: method.stretch.minRun })
  const tone = side === null ? null : verdictTone(null, side)
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
            formatValue={formatValue} baseline={strip.baseline} bands={strip.bands} bandLabels={bandLabels}
            pointStandings={strip.pointStandings} pointJudged={strip.pointJudged}
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
