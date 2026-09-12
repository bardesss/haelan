import { useId, useState } from 'react'
import type { RefObject, CSSProperties } from 'react'
import { useBasisId } from '../components/basis.js'
import { useTranslation } from '../i18n/index.js'

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
  const { t } = useTranslation()
  // Component state, not localStorage, following HeartRateRange's own band toggle and the reason
  // given there: this is a fact about the view rather than about the reader, and nothing asks it to
  // survive a navigation.
  const [shown, setShown] = useState(false)
  const tableId = useId()

  return (
    <figure style={{ margin: 0 }}>
      <div ref={host} role="img" aria-label={label} aria-describedby={describedBy} style={style} />
      {/*
        The table below is rendered, and in the accessibility tree, whether this control has been
        pressed or not. That is the whole design of this control and the reason it is not a
        <details>: collapsed <details> content leaves the accessibility tree, so wrapping the table
        in one would take it away from the screen readers who are currently its only audience, in
        the name of giving it to everyone else. This button changes pixels only, the same rule
        app.css states for the collapsed rail.
      */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="chart-table-toggle" aria-expanded={shown} aria-controls={tableId}
          aria-label={t(shown ? 'charts.tableToggle.hideFor' : 'charts.tableToggle.showFor', { label })}
          onClick={() => setShown((current) => !current)}>
          {t(shown ? 'charts.tableToggle.hide' : 'charts.tableToggle.show')}
        </button>
      </div>
      {/*
        The wrapper is what keeps this table out of the page's width while it is hidden, and
        .sr-only alone cannot do it. A table's used width is floored at its min-content width, so
        `width: 1px` does not shrink one: measured in a browser, this table stays about 400px
        however small it is asked to be, and being absolutely positioned it then stretched the
        document's scrollable area past the viewport. Every chart page carried a horizontal
        scrollbar because of it, a couple of pixels wide and easy to read as a rendering quirk.

        A div has no such floor, so the wrapper really is 1px, and because .sr-only positions it
        the wrapper becomes this table's containing block: its overflow: hidden clips the table
        rather than letting it push the page. table-layout: fixed, max-width and contain were all
        measured first and none of them shrink a table. The class stays on the table as well so
        that what a screen reader reads is unchanged.

        Shown, the same floor is why .chart-table is a scroll box rather than a plain block: the
        table is allowed to be as wide as it needs and scrolls inside the card, and a year's 365
        rows scroll vertically instead of pushing the page down.
      */}
      <div id={tableId} className={shown ? 'chart-table' : 'sr-only'}>
      <table className={shown ? '' : 'sr-only'}>
        <caption>{label}</caption>
        <thead>
          <tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {/*
            Keyed by index, not by row[0]: every chart before IntradayHeartRate keyed on a date,
            unique per row by construction, so an index key would have been indistinguishable from
            one. IntradayHeartRate draws one row per point per source, and two sources reporting
            the same minute (readIntraday's own reason to keep sources separate at all) print the
            same time in row[0], so a row[0] key collided across sources: a real duplicate-key case,
            not a hypothetical one. An index key is the right tool specifically because this table
            is never reordered and never filtered (`rows` is rebuilt fresh from `points`/`days` on
            every render, in the same order, with no row ever inserted, removed or resorted in
            place), which is the one condition under which an index key is not the smell it usually
            is.
          */}
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
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
