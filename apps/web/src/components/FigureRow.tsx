// One figure on a detail page: label, value, where it sits against the usual, and the verdict in
// words. The server has already judged it (standing, better or worse); this only draws. The bar uses
// the dashboard gauge's scale, the usual band in the middle fifth, so "inside" and "outside" read the
// same on every page. A strip of the last days replaces the bar where the trend is the point.
// `band` takes a figure's baseline as the server sends it; a thin one draws no bar at all, since a
// band from three nights looks exactly as authoritative as one from sixty (bandFrom's rule).
import { useId } from 'react'
import { gaugeFraction, gaugeScale } from '../pages/dashboard/UsualGauge.js'
import { Sparkline } from '../charts/Sparkline.js'
import { BasisContext } from './basis.js'
import type { PointStanding } from '../charts/base.js'

export interface FigureRowStrip {
  values: (number | null)[], labels: string[], bands?: readonly ({ low: number, high: number } | null)[]
  metric: string, unit: string, formatValue: (value: number | null, absent: string) => string
  // Where the server said each day stood, so a day outside its usual takes the warning colour.
  pointStandings?: readonly PointStanding[]
  // The chart's accessible name when the row's own label is not enough to tell it from another
  // chart on the same page (two called "HRV", say); the row's label otherwise.
  label?: string
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`

/**
 * The colour a figure's verdict takes, the dashboard's rule: a judged figure keeps its judgement
 * (better, worse), and a figure the server judged neither way - a neutral one, like a bedtime -
 * that still sits outside its usual takes the dashboard's "outside usual" mark (`is-out`, the
 * night card's own class for a bedtime or wake time off its usual), so "outside your usual" never
 * reads in the same grey as "within". Null inside the usual, or with nothing to stand against.
 */
export function verdictTone(judged: 'better' | 'worse' | null, standing: 'within' | 'above' | 'below' | null | undefined):
  'better' | 'worse' | 'is-out' | null {
  if (judged !== null) return judged
  return standing === 'above' || standing === 'below' ? 'is-out' : null
}

/**
 * `standing` is where the server said the figure sits against its usual; it only colours a figure
 * `judged` leaves plain (verdictTone). The verdict line is the strip's description by id, the same
 * wiring Card gives its basis line, so a screen reader hears the verdict once, where it is printed,
 * rather than once there and again from a hidden copy.
 */
export function FigureRow({ label, value, verdict, judged, standing, band, mark, strip }: {
  label: string, value: string, verdict: string, judged: 'better' | 'worse' | null
  standing?: 'within' | 'above' | 'below' | null
  band: { center: number, low: number, high: number, thin: boolean } | null, mark: number | null, strip?: FigureRowStrip
}) {
  const verdictId = useId()
  const scale = band === null || band.thin ? null : gaugeScale(band)
  const tone = verdictTone(judged, standing)
  // The mark takes the warning colour exactly when the verdict does, bar the good news: a better
  // figure's words turn green, and a green mark on a blue band would read as a second series.
  const marked = tone === 'worse' || tone === 'is-out'
  return (
    <div className="figure-row">
      {/* .label, the card label's own style, so the app spells a small uppercase label one way. */}
      <span className="label figure-row-label">{label}</span>
      <span className="figure-row-value">{value}</span>
      {strip !== undefined ? (
        <BasisContext.Provider value={verdictId}>
          <Sparkline values={strip.values} labels={strip.labels} label={strip.label ?? label} unit={strip.unit} metric={strip.metric}
            formatValue={strip.formatValue} bands={strip.bands} pointStandings={strip.pointStandings} height={30} dots tableToggle={false} />
        </BasisContext.Provider>
      ) : scale !== null && band !== null && (
        <div className="figure-row-bar" aria-hidden="true">
          <span className="figure-row-band" style={{ left: pct(gaugeFraction(band.low, scale)), width: pct(gaugeFraction(band.high, scale) - gaugeFraction(band.low, scale)) }} />
          {mark !== null && <span className={marked ? `figure-row-mark ${tone}` : 'figure-row-mark'} style={{ left: pct(gaugeFraction(mark, scale)) }} />}
        </div>
      )}
      <span id={verdictId} className={tone === null ? 'figure-row-verdict' : `figure-row-verdict ${tone}`}>{verdict}</span>
    </div>
  )
}
