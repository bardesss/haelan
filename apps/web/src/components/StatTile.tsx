import { useId } from 'react'
import { BasisContext } from './basis.js'
import { toneOf, type Delta } from '../format.js'

export function StatTile({ label, value, unit, basis, delta, children }: {
  label: string
  value: string
  unit?: string
  basis: string
  delta?: Delta
  children?: React.ReactNode
}) {
  const basisId = useId()
  // A delta with no stated basis is a number without a claim attached; the
  // window it compares is part of the number, not a footnote.
  const fullBasis = delta?.basis ? `${basis}; ${delta.basis}` : basis
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">{label}</span>
        {delta && <span className="delta" data-dir={delta.dir} data-tone={toneOf(delta)}>{delta.text}</span>}
      </header>
      <div className="value">{value}{unit && <span style={{ fontSize: 'var(--font-size-lg)', color: 'var(--text-muted)' }}> {unit}</span>}</div>
      <p className="basis" id={basisId}>{fullBasis}</p>
      <BasisContext.Provider value={basisId}>{children}</BasisContext.Provider>
    </>
  )
}
