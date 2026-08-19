type Delta = { text: string; dir: 'up' | 'down' | 'flat' }

export function StatTile({ label, value, unit, basis, delta, children }: {
  label: string
  value: string
  unit?: string
  basis: string
  delta?: Delta
  children?: React.ReactNode
}) {
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">{label}</span>
        {delta && <span className="delta" data-dir={delta.dir}>{delta.text}</span>}
      </header>
      <div className="value">{value}{unit && <span style={{ fontSize: 'var(--text-lg)', color: 'var(--text-muted)' }}> {unit}</span>}</div>
      <p className="basis">{basis}</p>
      {children}
    </>
  )
}
