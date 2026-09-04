import { useId } from 'react'
import { BasisContext } from './basis.js'
import { ErrorBoundary } from './ErrorBoundary.js'

export function Card({ span, label, basis, children }: {
  span: number
  label?: string
  basis?: string
  children: React.ReactNode
}) {
  const basisId = useId()
  return (
    <section className="card" style={{ gridColumn: `span ${span}` }}>
      {label && <span className="label">{label}</span>}
      {basis && <p className="basis" id={basisId}>{basis}</p>}
      <BasisContext.Provider value={basis ? basisId : undefined}>
        {/* Inside the card rather than around it, so a card whose contents throw keeps its frame,
            its label and its basis line and the reader can see which card failed. Per card rather
            than per page, because per page one absent field still costs the reader everything. */}
        <ErrorBoundary>{children}</ErrorBoundary>
      </BasisContext.Provider>
    </section>
  )
}
