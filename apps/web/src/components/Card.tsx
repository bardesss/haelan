import { useId } from 'react'
import { BasisContext } from './basis.js'

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
      <BasisContext.Provider value={basis ? basisId : undefined}>{children}</BasisContext.Provider>
    </section>
  )
}
