const RANGES = ['Day', 'Week', 'Month', '3 months', 'Year'] as const

export function ControlRow({ range, label, sources, syncedAgo }: {
  range: string
  label: string
  sources: string
  syncedAgo: string
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', background: 'var(--surface-inset)', borderRadius: 'var(--radius-md)', padding: 2 }}>
        {RANGES.map((r) => (
          <span key={r} className="basis" style={{ padding: '4px 10px', borderRadius: 6, margin: 0,
            background: r === range ? 'var(--surface-card)' : undefined,
            color: r === range ? 'var(--text-primary)' : undefined }}>{r}</span>
        ))}
      </div>
      <div className="basis" style={{ margin: 0, padding: '4px 10px' }}>&lsaquo; {label} &rsaquo;</div>
      <div className="basis" style={{ margin: 0, marginLeft: 'auto' }}>Sources {sources}</div>
      <div className="basis" style={{ margin: 0 }}>Download raw</div>
      <div className="basis" style={{ margin: 0 }}>Sync</div>
      <div className="basis" style={{ margin: 0, color: 'var(--text-faint)' }}>{syncedAgo}</div>
    </div>
  )
}
