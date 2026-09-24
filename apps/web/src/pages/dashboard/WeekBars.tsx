const TONE_CLASS = { steps: 'week-bars is-steps', active: 'week-bars is-active', sleep: 'week-bars is-sleep' }

/** Seven small bars, oldest first, today last and highlighted; a silent day is a gap, not a zero-height bar. */
export function WeekBars({ values, tone, label }: { values: (number | null)[], tone: 'steps' | 'active' | 'sleep', label: string }) {
  const max = Math.max(1, ...values.filter((v): v is number => v !== null))
  const w = 112
  const h = 40
  const step = w / values.length
  return (
    <svg className={TONE_CLASS[tone]} role="img" aria-label={label} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {values.map((v, i) => v === null ? null : (
        <rect key={i} className={i === values.length - 1 ? 'week-bar is-today' : 'week-bar'}
          x={i * step + 2} y={h - (v / max) * (h - 2)} width={step - 5} height={(v / max) * (h - 2)} rx={2} />
      ))}
    </svg>
  )
}
