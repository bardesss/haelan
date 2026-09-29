// One figure on a detail page: label, value, where it sits against the usual, and the verdict in
// words. The server has already judged it (standing, better or worse); this only draws. The bar uses
// the dashboard gauge's scale, the usual band in the middle fifth, so "inside" and "outside" read the
// same on every page. A strip of the last days replaces the bar where the trend is the point.
// `band` takes a figure's baseline as the server sends it; a thin one draws no bar at all, since a
// band from three nights looks exactly as authoritative as one from sixty (bandFrom's rule).
import { Children, useId } from 'react'
import type { ReactNode } from 'react'
import { gaugeFraction, gaugeScale } from '../pages/dashboard/UsualGauge.js'
import { Sparkline } from '../charts/Sparkline.js'
import { BasisContext } from './basis.js'
import { verdictTone } from '../charts/base.js'
import type { PointJudged, PointStanding } from '../charts/base.js'

// verdictTone lives in charts/base.ts, since a strip's dots take the same tone; re-exported here,
// where every detail page has always imported it from.
export { verdictTone }

export interface FigureRowStrip {
  values: (number | null)[], labels: string[], bands?: readonly ({ low: number, high: number } | null)[]
  metric: string, unit: string, formatValue: (value: number | null, absent: string) => string
  // Where the server said each day stood and how it judged it, so each dot takes its day's verdict tone.
  pointStandings?: readonly PointStanding[]
  pointJudged?: readonly PointJudged[]
  // The chart's accessible name when the row's own label is not enough to tell it from another
  // chart on the same page (two called "HRV", say); the row's label otherwise.
  label?: string
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`

// A formatted value's number and its unit, split at the last no-break space figureText puts between
// them ("13.8 breaths/min"), so the unit can be set smaller and a long one still fits its column.
// No split where the last part is itself a number (a duration's "04m", a clock time).
function valueParts(value: string): { number: string, unit: string | null } {
  const at = value.lastIndexOf('\u00a0')
  const unit = at < 0 ? '' : value.slice(at + 1)
  return at < 0 || /^[\d+-]/.test(unit) ? { number: value, unit: null } : { number: value.slice(0, at + 1), unit }
}

/**
 * A card's grid of FigureRows: as many columns as it has rows, up to `max` (four across a full
 * card, three where a card gives them three quarters), so one figure never sits in a quarter of its
 * card beside three empty ones. Two across below the grid's collapse width, where a card is as
 * narrow as a phone's (app.css). `side` is the same grid inside a SideCard, capped at three.
 */
export function FigureRows({ max, side = false, children }: { max?: 1 | 2 | 3 | 4, side?: boolean, children: ReactNode }) {
  // Children.toArray drops the false and null a condition leaves, so only rows are counted.
  const columns = Math.max(1, Math.min(Children.toArray(children).length, max ?? (side ? 3 : 4)))
  return <div className={side ? 'detail-side-rows' : 'detail-rows'} data-columns={columns}>{children}</div>
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
  const parts = valueParts(value)
  // The mark takes the warning colour exactly when the verdict does, bar the good news: a better
  // figure's words turn green, and a green mark on a blue band would read as a second series.
  const marked = tone === 'worse' || tone === 'is-out'
  return (
    <div className="figure-row">
      {/* .label, the card label's own style, so the app spells a small uppercase label one way. */}
      <span className="label figure-row-label">{label}</span>
      <span className="figure-row-value">{parts.number}{parts.unit !== null && <span className="figure-row-unit">{parts.unit}</span>}</span>
      {strip !== undefined ? (
        <BasisContext.Provider value={verdictId}>
          <Sparkline values={strip.values} labels={strip.labels} label={strip.label ?? label} unit={strip.unit} metric={strip.metric}
            formatValue={strip.formatValue} bands={strip.bands} pointStandings={strip.pointStandings} pointJudged={strip.pointJudged} height={30} dots tableToggle={false} />
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
