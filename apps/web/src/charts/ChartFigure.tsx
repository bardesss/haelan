import type { RefObject, CSSProperties } from 'react'
import { useBasisId } from '../components/basis.js'

// The numbers a chart draws, in the order a reader would read them out.
export type ChartTable = {
  columns: string[]
  rows: (string | number)[][]
}

// Every chart gets a name, the card's basis line as its description, and the
// same numbers as a table. A canvas or an SVG blob with no accessible name is a
// chart only for the people who can see it.
export function ChartFigure({ label, table, host, style }: {
  label: string
  table: ChartTable
  host: RefObject<HTMLDivElement | null>
  style: CSSProperties
}) {
  const describedBy = useBasisId()
  return (
    <figure style={{ margin: 0 }}>
      <div ref={host} role="img" aria-label={label} aria-describedby={describedBy} style={style} />
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={String(row[0])}>
              {row.map((cell, i) => (
                i === 0 ? <th key={i} scope="row">{cell}</th> : <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
