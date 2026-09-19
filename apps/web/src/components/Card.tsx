import { useId } from 'react'
import { BasisContext } from './basis.js'
import { ErrorBoundary } from './ErrorBoundary.js'
// Circular with CardGrid.tsx (which imports Card from here). Safe only because both sides defer
// their use to a function-body call site — Card is a hoisted function declaration, and
// useCardPresence is only read inside a hook body — so it never matters which module evaluates
// first. Hoisting either use to module-evaluation scope would break that silently.
import { useCardPresence } from './CardGrid.js'

export function Card({ span, label, basis, measured = false, ambient, children }: {
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
  /**
   * A card whose content does not come from the period the page is showing, so it must not speak
   * for the page. It renders exactly as any other card; it simply does not count toward the tally
   * CardGrid reads to decide whether every card has hidden itself.
   *
   * Two cards carry this today.
   *
   * Dashboard's flagged days reads the reader's own annotations rather than anything synced, and
   * so renders on a day where nothing was recorded at all. Without this prop it alone would hold
   * that tally above zero and make the page level empty state unreachable on the one page that
   * prompted the feature.
   *
   * The recovery index tile's unavailable branch (RecoveryIndexTile.tsx) is the second, and it is
   * a narrower fit for the doc comment above than the flagged days card is: its message DOES come
   * from the period, naming the gates the index failed for that day. What makes it ambient is not
   * where its content comes from but what its presence proves, which is nothing about the period:
   * it renders identically whether the day has a full archive blocked only by a thin baseline, or
   * nothing was recorded at all. A page-level empty state has to tell those two days apart, and a
   * card that speaks the same sentence on both of them cannot be the thing holding the tally above
   * zero on either. Its design spec requires the sentence stay on screen either way (a withheld day
   * must read as a stated reason, never as an empty tile), so the fix is here rather than in
   * MetricCard's render-nothing answer, which does not have a spec pulling the other way.
   *
   * That is what this exists for, and why it is not a simplification waiting to be made.
   */
  ambient?: boolean
  children: React.ReactNode
}) {
  // Reports this card to the enclosing CardGrid, so a page whose cards have all hidden themselves
  // can say so once instead of rendering a bare control row. A no-op outside a CardGrid. See
  // CardGrid.tsx for why the shell reports rather than each gate.
  useCardPresence(ambient !== true)
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
