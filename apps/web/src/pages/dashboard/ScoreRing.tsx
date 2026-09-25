/**
 * The recovery index as a filled ring. A ring suits it and nothing else on the page: 0-100 is a
 * real scale with a real top. Static SVG rather than an echarts gauge: nothing on it is hovered or
 * zoomed, and it renders under renderToStaticMarkup with no DOM. Colours come from app.css classes
 * over tokens, never from attributes here (no-raw-color).
 */
export function ScoreRing({ value, size, label, emptyText }: { value: number | null, size: number, label: string, emptyText: string }) {
  const stroke = Math.round(size * 0.09)
  const r = size / 2 - stroke / 2 - 1
  const c = 2 * Math.PI * r
  return (
    <svg className="score-ring" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle className="score-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      {value !== null && (
        <circle className="score-ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none"
          strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
      <text className={value === null ? 'score-ring-empty' : 'score-ring-value'} x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {value === null ? emptyText : Math.round(value)}
      </text>
    </svg>
  )
}
