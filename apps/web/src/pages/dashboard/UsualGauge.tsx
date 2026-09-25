import type { GlanceStanding } from '../../data/useGlance.js'

export function gaugeScale(band: { low: number, high: number, center: number }): { min: number, max: number } {
  // The band fills the middle fifth of the arc, so "inside" and "outside" read at once. A band of
  // zero width (one reading, or a perfectly steady person) still gets an arc: 10% of the centre.
  const half = (band.high - band.low) / 2 || Math.max(Math.abs(band.center) * 0.1, 1)
  return { min: band.center - half * 2.5, max: band.center + half * 2.5 }
}

export function gaugeFraction(value: number, scale: { min: number, max: number }): number {
  return Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)))
}

// A point on the upper half circle, f = 0 at the left end and 1 at the right.
function point(cx: number, cy: number, r: number, f: number): [number, number] {
  const a = Math.PI * (1 - f)
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}
function arc(cx: number, cy: number, r: number, f0: number, f1: number): string {
  const [x0, y0] = point(cx, cy, r, f0)
  const [x1, y1] = point(cx, cy, r, f1)
  return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`
}

/**
 * A reading with no natural maximum (resting heart rate, HRV) against the person's usual: a half
 * arc whose shaded stretch is the usual range and whose marker is today. Not a filling ring, which
 * would read "more is better" and is wrong for resting heart rate. With no band to stand on (none,
 * or thin) it draws the number on a plain arc and no marker position is claimed.
 */
export function UsualGauge({ value, unit, baseline, standing, size, label }: {
  value: number, unit: string, baseline: { low: number, high: number, center: number } | null
  standing: GlanceStanding | null, size: number, label: string
}) {
  const stroke = Math.round(size * 0.09)
  const cx = size / 2
  const cy = size / 2 + stroke
  const r = size / 2 - stroke
  const scale = baseline === null ? null : gaugeScale(baseline)
  const out = standing === 'above' || standing === 'below'
  return (
    <svg className="usual-gauge" role="img" aria-label={label} width={size} height={size / 2 + stroke * 3} viewBox={`0 0 ${size} ${size / 2 + stroke * 3}`}>
      <path className="usual-gauge-track" d={arc(cx, cy, r, 0, 1)} strokeWidth={stroke} fill="none" strokeLinecap="round" />
      {scale !== null && baseline !== null && (
        <>
          <path className="usual-gauge-band" d={arc(cx, cy, r, gaugeFraction(baseline.low, scale), gaugeFraction(baseline.high, scale))} strokeWidth={stroke} fill="none" />
          {(() => { const [mx, my] = point(cx, cy, r, gaugeFraction(value, scale)); return <circle className={out ? 'usual-gauge-marker is-out' : 'usual-gauge-marker'} cx={mx} cy={my} r={stroke * 0.75} strokeWidth={2.5} /> })()}
        </>
      )}
      <text className="usual-gauge-value" x={cx} y={cy - stroke * 0.4} textAnchor="middle">{Math.round(value)}</text>
      <text className="usual-gauge-unit" x={cx} y={cy + stroke * 1.4} textAnchor="middle">{unit}</text>
    </svg>
  )
}
