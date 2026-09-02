import type { RefObject, CSSProperties } from 'react'
import { useBasisId } from '../components/basis.js'

export type ChartTable = {
  columns: string[]
  rows: (string | number)[][]
}

// Accessible chart: a name, the card's basis line as description, and the same numbers as a table.
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
      {/*
        The wrapper is what keeps this table out of the page's width, and .sr-only alone cannot do
        it. A table's used width is floored at its min-content width, so `width: 1px` does not
        shrink one: measured in a browser, this table stays about 400px however small it is asked
        to be, and being absolutely positioned it then stretched the document's scrollable area
        past the viewport. Every chart page carried a horizontal scrollbar because of it, a couple
        of pixels wide and easy to read as a rendering quirk.

        A div has no such floor, so the wrapper really is 1px, and because .sr-only positions it
        the wrapper becomes this table's containing block: its overflow: hidden clips the table
        rather than letting it push the page. table-layout: fixed, max-width and contain were all
        measured first and none of them shrink a table. The class stays on the table as well so
        that what a screen reader reads is unchanged.
      */}
      <div className="sr-only">
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
      </div>
    </figure>
  )
}
