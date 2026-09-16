import { useId } from 'react'
import { BasisContext } from './basis.js'
import { toneOf, type Delta } from '../format.js'

export function StatTile({ label, value, unit, basis, delta, children }: {
  label: string
  value: string
  unit?: string
  /**
   * Optional, for the one caller whose tiles all share a single basis: a card stating "as the
   * provider recorded it" once above five tiles says it once, where a basis per tile said the
   * same sentence five times. Card carries the same prop and the same BasisContext wiring for
   * exactly that case, so the sentence moves up a level rather than disappearing.
   */
  basis?: string
  delta?: Delta
  children?: React.ReactNode
}) {
  const basisId = useId()
  // Both halves optional, so a delta's own basis can never be concatenated onto an absent one and
  // render the word "undefined" at a reader.
  const parts = [basis, delta?.basis].filter((part): part is string => part !== undefined && part !== '')
  const fullBasis = parts.length > 0 ? parts.join('; ') : null
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">{label}</span>
        {delta && <span className="delta" data-dir={delta.dir} data-tone={toneOf(delta)}>{delta.text}</span>}
      </header>
      <div className="value">{value}{unit && <span style={{ fontSize: 'var(--font-size-lg)', color: 'var(--text-muted)' }}> {unit}</span>}</div>
      {fullBasis !== null && <p className="basis" id={basisId}>{fullBasis}</p>}
      <BasisContext.Provider value={fullBasis !== null ? basisId : undefined}>{children}</BasisContext.Provider>
    </>
  )
}
