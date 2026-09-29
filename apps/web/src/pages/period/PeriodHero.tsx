import { useCallback, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { verdictTone } from '../../components/FigureRow.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { PeriodFigure, PeriodStripPoint } from '../../data/periodTypes.js'
import { formatFigureValue } from '../detail/figureText.js'
import { dayCountsLine, latestBand, periodStripOf, periodValueLine, periodVerdictLine } from '../detail/periodText.js'

/**
 * An overview page's lead, NightHero's markup over the period read (PATTERNS.md's "Overview
 * pages"): the period's figure in display type, the verdict against the usual for a period of that
 * length, then the day counts and the stood-out line, each a quiet line under the verdict. Beside
 * them the strip of the period's points (its days, or on 3 months and Year its weeks), each shaded
 * with its own usual, toned by its own verdict, and a good one ringed.
 *
 * A dot opens a small panel under the strip rather than a page: `panel` gives its contents for the
 * point, a PointPanel, which the hero closes through the `close` it is handed. The day-metric
 * exclude and annotate stay reachable from there.
 *
 * Nothing at all without a value, so the grid closes up. The strip's arrays and formatter are
 * memoised on the figure: a fresh one every render would rebuild the chart.
 */
export function PeriodHero({ label, figure, noun, standout, caption, lastYear, panel }: {
  label: string
  figure: PeriodFigure
  noun: 'night' | 'day'
  /** From standoutLine; null when nothing stood out. */
  standout: string | null
  /** What the points are: "each night of this month", "each week of this year". */
  caption: string
  /** The same days a year earlier, aligned to the daily points; ignored when the strip is weekly. */
  lastYear?: (number | null)[]
  /** The PointPanel for a tapped point, and how it closes itself. */
  panel: (point: PeriodStripPoint, close: () => void) => ReactNode
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const captionId = useId()
  const strip = useMemo(() => periodStripOf(figure), [figure])
  const points = figure.weekly ?? figure.daily
  // The good points' rings (Sparkline's pointMarks): the server's judged better, and nothing else.
  const marks = useMemo(() => points.map((point) => (point.judged === 'better' ? 'good' as const : undefined)), [points])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatFigureValue(figure, value, language, t)),
    [figure, language, t],
  )
  // The labels name the band drawn behind the points, the latest point's own usual (the dashboard's
  // "the day shown, the last step"), not the period's: that one is printed in the verdict, and as a
  // band of period averages it is far narrower than any day's, so its two edge labels overprinted
  // each other on a strip that never shades it.
  const band = useMemo(() => {
    const latest = latestBand(points)
    return latest === null ? undefined : { low: latest.low, high: latest.high }
  }, [points])
  const bandLabels = useMemo(() => band === undefined ? undefined : {
    low: formatFigureValue(figure, band.low, language, t), high: formatFigureValue(figure, band.high, language, t),
  }, [figure, band, language, t])

  // A dot opens the panel, so the tooltip's tail and a phone's tap control say that, not the chart's
  // default "Tap a point to annotate" (Sparkline's opensDay). No point is the one on screen: `current`
  // matches none.
  const opens = useMemo(() => ({
    current: '', tail: t('period.tap.tail'), idle: t('period.tap.idle'),
    named: (date: string) => t('period.tap.named', { date }),
  }), [t])

  // The open point by the date it starts on, which is what a dot's click hands back (its label).
  // Kept with the period it was opened in: a new period (a range or date change) closes it, even
  // where a point of the new one starts on the same date.
  const period = figure.daily[0]?.from ?? figure.weekly?.[0]?.from ?? null
  const [opened, setOpened] = useState<{ period: string | null, from: string } | null>(null)
  const openAt = useCallback((from: string) => setOpened({ period, from }), [period])
  const close = useCallback(() => setOpened(null), [])
  const open = opened === null || opened.period !== period ? undefined : points.find((point) => point.from === opened.from)

  if (figure.value === null) return null
  const { value, under } = periodValueLine(figure, language, t)
  const verdict = periodVerdictLine(figure, language, t)
  const counts = dayCountsLine(figure, noun, t)
  const tone = verdictTone(figure.judged, figure.standing)

  return (
    <Card span={12} label={label}>
      <div className="dash-lead detail-hero">
        <div>
          <div className="dash-headline detail-hero-value">{value}</div>
          {under !== null && <p className="workout-hero-line">{under}</p>}
          {verdict !== null && (
            <p id={verdictId} className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdict}</p>
          )}
          {counts !== null && <p className="workout-hero-line">{counts}</p>}
          {standout !== null && <p className="workout-hero-line">{standout}</p>}
        </div>
        {strip !== null && (
          <div className="dash-lead-strip period-hero-strip">
            <BasisContext.Provider value={verdict !== null ? verdictId : captionId}>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric={figure.metric}
                formatValue={formatValue} baseline={band} bands={strip.bands} bandLabels={bandLabels}
                pointStandings={strip.pointStandings} pointJudged={strip.pointJudged} pointMarks={marks}
                lastYear={strip.weekly ? undefined : lastYear} height={64} dots tableToggle={false} onPointClick={openAt} opensDay={opens} />
            </BasisContext.Provider>
            <p id={captionId} className="dash-caption">{caption}</p>
            {open !== undefined && <div key={open.from} className="period-hero-panel">{panel(open, close)}</div>}
          </div>
        )}
      </div>
    </Card>
  )
}
