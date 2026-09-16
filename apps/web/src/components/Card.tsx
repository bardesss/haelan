import { useId } from 'react'
import { BasisContext } from './basis.js'
import { ErrorBoundary } from './ErrorBoundary.js'

export function Card({ span, label, basis, measured = false, children }: {
  span: number
  label?: string
  basis?: string
  /**
   * For a card holding reading matter rather than a chart: it keeps its span, so nothing about
   * the grid or the phone rules changes, and stops at a measure on a wide screen instead of
   * stretching its contents across the whole window. A boolean rather than a className, because
   * the only choice a caller has here is whether its content reads like prose or draws like a
   * chart, and a free-form class would invite answers to other questions.
   */
  measured?: boolean
  children: React.ReactNode
}) {
  const basisId = useId()
  return (
    <section className={measured ? 'card card-measured' : 'card'}
      style={{ gridColumn: `span ${span}` }}>
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
