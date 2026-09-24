import { useId } from 'react'
import type { ReactNode } from 'react'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { Link } from '../../router.js'

// The card's name and its muted span ("so far", "today"). No stale-source mark beside it: a quiet
// source is announced once, in the status panel (StatusPanel.tsx), like on every other page.
export function DashTitle({ title, subtitle }: { title: string, subtitle: string | null }) {
  return (
    <h2 className="dash-card-title">
      <strong>{title}</strong>{subtitle !== null && <>{' '}<span>{subtitle}</span></>}
    </h2>
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
 * card's title and an optional link to the page that says the rest, and whatever the card itself
 * puts under that row.
 */
export function DashCard({ span, title, subtitle, link, className, children }: {
  span: 4 | 8 | 12, title: string, subtitle: string | null, link?: { to: string, text: string }
  className?: string, children: ReactNode
}) {
  return (
    <Card span={span}>
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
