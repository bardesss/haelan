import { useId } from 'react'
import type { ReactNode } from 'react'
import type { GlanceFigure, GlanceStaleSource } from '../../data/useGlance.js'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { SourceWarning, useUnshownCardWarning } from '../../components/SourceWarning.js'
import { staleSentence } from '../../components/staleSentence.js'
import { Link } from '../../router.js'
import { useTranslation } from '../../i18n/index.js'

// A stable empty list for a card with no chart, so the union below is not rebuilt against a fresh
// `[]` default on every render - the same device Sparkline.tsx's own EMPTY constant uses.
export const NO_SOURCES: readonly GlanceStaleSource[] = Object.freeze([])

// Every stale source behind anything this card shows, once each. Keyed on sourceId rather than on
// the name, because two sources can share a display name while being two separate devices that
// each went quiet, and one watch feeding three of the card's figures must still read as one
// sentence rather than the same sentence three times over.
function staleUnion(figures: readonly GlanceFigure[], extra: readonly GlanceStaleSource[]): GlanceStaleSource[] {
  const seen = new Map<string, GlanceStaleSource>()
  for (const source of [...figures.flatMap((f) => f.staleSources), ...extra]) {
    if (!seen.has(source.sourceId)) seen.set(source.sourceId, source)
  }
  return [...seen.values()]
}

// The column's name and its muted span ("so far", "today"), and the stale-source mark beside them.
// A component of its own rather than markup inline in GlanceCard, because the mark arrives through
// Card's context (this card passes Card no label, so Card hands the warning down instead of drawing
// it), and a context is only readable from inside the provider Card renders around its children.
// The mark sits after the heading rather than inside it: its sentence is read out through an
// sr-only span, and inside the h2 that sentence became part of the heading's accessible name, so a
// screen reader listing headings heard a whole warning where the column's name should be.
export function DashTitle({ title, subtitle }: { title: string, subtitle: string | null }) {
  const warning = useUnshownCardWarning()
  return (
    <>
      <h2 className="dash-card-title">
        <strong>{title}</strong>{subtitle !== null && <>{' '}<span>{subtitle}</span></>}
      </h2>
      {warning !== null && <SourceWarning text={warning} />}
    </>
  )
}

/**
 * A chart and the line that describes it, wired the way Card and StatTile wire a basis line: the
 * line's id goes into BasisContext, and ChartFigure points the chart's aria-describedby at it. A
 * glance card hands Card no basis (its columns say what they are in their own words), so without
 * this a chart inside one had a name and no description, which pages.test.tsx's chart rule refuses.
 * `hidden` keeps the line for a screen reader only, for a chart whose card already prints the same
 * fact where a sighted reader looks for it.
 */
export function Described({ text, hidden = false, children }: { text: string, hidden?: boolean, children: ReactNode }) {
  const id = useId()
  return (
    <div>
      <BasisContext.Provider value={id}>{children}</BasisContext.Provider>
      <p className={hidden ? 'sr-only' : 'glance-asof'} id={id}>{text}</p>
    </div>
  )
}

/**
 * The shared chrome every redesigned dashboard card wears: a span-sized Card, a head row with the
 * card's title, its stale-source mark and an optional link to the page that says the rest, and
 * whatever the card itself puts under that row.
 */
export function DashCard({ span, title, subtitle, link, staleFigures, staleExtra = NO_SOURCES, className, children }: {
  span: 4 | 8 | 12, title: string, subtitle: string | null, link?: { to: string, text: string }
  staleFigures: readonly GlanceFigure[], staleExtra?: readonly GlanceStaleSource[], className?: string, children: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const warning = staleSentence(staleUnion(staleFigures, staleExtra), t, i18n.language)
  return (
    <Card span={span} warning={warning}>
      <div className={className === undefined ? 'dash-card' : `dash-card ${className}`}>
        <div className="dash-card-head">
          <DashTitle title={title} subtitle={subtitle} />
          {link !== undefined && <Link to={link.to} className="card-link">{link.text}</Link>}
        </div>
        {children}
      </div>
    </Card>
  )
}

export { staleUnion }
