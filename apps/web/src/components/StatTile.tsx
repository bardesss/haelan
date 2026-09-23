import { useId } from 'react'
import { BasisContext } from './basis.js'
import { useTranslation } from '../i18n/index.js'
import { SourceWarning, useUnshownCardWarning } from './SourceWarning.js'
import { toneOf, type Delta } from '../format.js'

export function StatTile({ label, value, unit, basis, delta, lastYear, children }: {
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
  /**
   * The same figure over the same days a year earlier, already formatted the way `value` is, for
   * a reader comparing years: a string draws "Last year: 52,110", null says a year earlier holds
   * nothing, and undefined (the comparison off, or still loading) draws nothing at all.
   */
  lastYear?: string | null
  children?: React.ReactNode
}) {
  const basisId = useId()
  const { t } = useTranslation()
  // A tile card has no Card label, so a stale-source warning on its card is drawn here, beside the
  // title the tile itself prints (SourceWarning.tsx).
  const warning = useUnshownCardWarning()
  // The printed line is the tile's own coverage only. The delta's method sentence ("change is the
  // mean of the last 16 readings against the first 15") used to follow it, and on a page of nine
  // tiles that was the same sentence nine times with only its numbers changing. It now belongs to
  // the badge it explains: its tooltip for a pointer, and its spoken text for a screen reader, so
  // what the percentage compared is still said wherever the percentage is.
  const fullBasis = basis !== undefined && basis !== '' ? basis : null
  const method = delta?.basis !== undefined && delta.basis !== '' ? delta.basis : null
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">{label}{warning !== null && <SourceWarning text={warning} />}</span>
        {delta && (
          <span className="delta" data-dir={delta.dir} data-tone={toneOf(delta)} title={method ?? undefined}>
            {delta.text}{method !== null && <span className="sr-only">; {method}</span>}
          </span>
        )}
      </header>
      <div className="value">{value}{unit && <span style={{ fontSize: 'var(--font-size-lg)', color: 'var(--text-muted)' }}> {unit}</span>}</div>
      {/* Directly under the headline it compares with, and above the basis: on a 34px line the
          dashed year-earlier shape is context, and this number is what a reader actually reads. */}
      {lastYear !== undefined && (
        <p className="last-year">
          {lastYear === null ? t('lastYear.none') : t('lastYear.value', { value: unit ? `${lastYear} ${unit}` : lastYear })}
        </p>
      )}
      {fullBasis !== null && <p className="basis" id={basisId}>{fullBasis}</p>}
      <BasisContext.Provider value={fullBasis !== null ? basisId : undefined}>{children}</BasisContext.Provider>
    </>
  )
}
