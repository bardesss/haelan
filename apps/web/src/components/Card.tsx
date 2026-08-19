export function Card({ span, children }: { span: number; children: React.ReactNode }) {
  return <section className="card" style={{ gridColumn: `span ${span}` }}>{children}</section>
}
