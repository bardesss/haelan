const TONE_CLASS = { steps: 'week-bars is-steps', active: 'week-bars is-active', sleep: 'week-bars is-sleep' }

// The day a bar stands for, read in words: the same UTC-midnight anchoring glanceText.ts's own
// formatShortDate uses, since a local date here names a calendar day, not an instant, and the
// weekday it falls on must not depend on which zone the browser sits in.
function dayWord(date: string, language: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' })
}

/**
 * Seven small bars, oldest first, today last and highlighted; a silent day is a gap, not a
 * zero-height bar. Each bar carries its own day and value as a `<title>`, formatted the same way
 * the row beside it prints its figure (`format`), so a screen reader gets the seven days the shape
 * alone draws for a sighted reader rather than just the one label on the svg as a whole.
 */
export function WeekBars({ values, dates, tone, label, language, format }: {
  values: (number | null)[], dates: string[], tone: 'steps' | 'active' | 'sleep', label: string,
  language: string, format: (value: number) => string,
}) {
  const max = Math.max(1, ...values.filter((v): v is number => v !== null))
  const w = 112
  const h = 40
  const step = w / values.length
  return (
    <svg className={TONE_CLASS[tone]} role="img" aria-label={label} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {values.map((v, i) => v === null ? null : (
        <rect key={i} className={i === values.length - 1 ? 'week-bar is-today' : 'week-bar'}
          x={i * step + 2} y={h - (v / max) * (h - 2)} width={step - 5} height={(v / max) * (h - 2)} rx={2}>
          <title>{`${dayWord(dates[i]!, language)} ${format(v)}`}</title>
        </rect>
      ))}
    </svg>
  )
}
