import { useId } from 'react'
import { BasisContext } from './basis.js'
import { ErrorBoundary } from './ErrorBoundary.js'
// Circular with CardGrid.tsx (which imports Card from here). Safe only because both sides defer
// their use to a function-body call site — Card is a hoisted function declaration, and
// useCardPresence is only read inside a hook body — so it never matters which module evaluates
// first. Hoisting either use to module-evaluation scope would break that silently.
import { useCardPresence } from './CardGrid.js'

export function Card({ span, label, basis, measured = false, ambient, id, children }: {
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
   * One card carries this today: the flagged days card (FlaggedDaysCard.tsx, on Notes since M9b),
   * which reads the reader's own annotations rather than anything synced, and so renders on a day
   * where nothing was recorded at all. Without this prop it alone would hold that tally above zero
   * and make the page level empty state unreachable, which is what it did on the old Dashboard
   * that prompted the feature.
   *
   * The old Dashboard's recovery index tile was the second, for a narrower reason: its unavailable
   * branch spoke the same sentence on a day blocked only by a thin baseline and on a day nothing
   * was recorded, so its presence proved nothing about the period. It went with the tile when the
   * Dashboard became the glance. A card whose presence proves nothing about the period the page
   * shows is still what this exists for, and why it is not a simplification waiting to be made.
   */
  ambient?: boolean
  /**
   * An anchor for a link that lands on this card, like the status panel's "Choose sources…",
   * which opens /account#sources. On the section itself rather than a wrapper around the card: a
   * wrapper div would become the grid item, and the card's own span would then size it inside a
   * one-column box.
   */
  id?: string
  children: React.ReactNode
}) {
  // Reports this card to the enclosing CardGrid, so a page whose cards have all hidden themselves
  // can say so once instead of rendering a bare control row. A no-op outside a CardGrid. See
  // CardGrid.tsx for why the shell reports rather than each gate.
  useCardPresence(ambient !== true)
  const basisId = useId()
  return (
    // data-span as well as the inline gridColumn, and the two never disagree because both read the
    // same prop. The attribute is what the mid-band media query in app.css can select on: a media
    // query cannot do arithmetic on an inline style, so halving a 12-column layout to 6 needs the
    // span to exist as something a selector can match. The inline style stays because it is what
    // sets the span at every other width, and deriving it from the attribute instead would put the
    // whole grid behind a stylesheet rule that a missing class would silently drop.
    <section id={id} className={measured ? 'card card-measured' : 'card'} data-span={span}
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
