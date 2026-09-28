// One figure on a detail page: label, value, where it sits against the usual, and the verdict in
// words. The server has already judged it (standing, better or worse); this only draws. The bar uses
// the dashboard gauge's scale, the usual band in the middle fifth, so "inside" and "outside" read the
// same on every page. A strip of the last days replaces the bar where the trend is the point.
import { gaugeFraction, gaugeScale } from '../pages/dashboard/UsualGauge.js'
import { Sparkline } from '../charts/Sparkline.js'
import { Described } from '../pages/dashboard/cardShared.js'

export interface FigureRowStrip {
  values: (number | null)[], labels: string[], bands?: readonly ({ low: number, high: number } | null)[]
  metric: string, unit: string, formatValue: (value: number | null, absent: string) => string
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`

export function FigureRow({ label, value, verdict, judged, band, mark, strip }: {
  label: string, value: string, verdict: string, judged: 'better' | 'worse' | null
  band: { center: number, low: number, high: number } | null, mark: number | null, strip?: FigureRowStrip
}) {
  const scale = band === null ? null : gaugeScale(band)
  return (
    <div className="figure-row">
      <span className="figure-row-label">{label}</span>
      <span className="figure-row-value">{value}</span>
      {strip !== undefined ? (
        <Described text={verdict} hidden>
          <Sparkline values={strip.values} labels={strip.labels} label={label} unit={strip.unit} metric={strip.metric}
            formatValue={strip.formatValue} bands={strip.bands} height={30} dots tableToggle={false} />
        </Described>
      ) : scale !== null && band !== null && (
        <div className="figure-row-bar" aria-hidden="true">
          <span className="figure-row-band" style={{ left: pct(gaugeFraction(band.low, scale)), width: pct(gaugeFraction(band.high, scale) - gaugeFraction(band.low, scale)) }} />
          {mark !== null && <span className={judged === 'worse' ? 'figure-row-mark worse' : 'figure-row-mark'} style={{ left: pct(gaugeFraction(mark, scale)) }} />}
        </div>
      )}
      <span className={judged === null ? 'figure-row-verdict' : `figure-row-verdict ${judged}`}>{verdict}</span>
    </div>
  )
}
