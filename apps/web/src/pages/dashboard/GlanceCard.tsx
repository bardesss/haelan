import { useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { GlanceFigure, GlanceStaleSource } from '../../data/useGlance.js'
import { Card } from '../../components/Card.js'
import { BasisContext } from '../../components/basis.js'
import { SourceWarning, useUnshownCardWarning } from '../../components/SourceWarning.js'
import { staleSentence } from '../../components/staleSentence.js'
import { Sparkline } from '../../charts/Sparkline.js'
import { Link } from '../../router.js'
import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { formatFigure, usualLine, asOfLine } from './glanceText.js'

/**
 * One figure as a glance card prints it. `unit` is display text the page has already translated
 * ("bpm", "min"), not the figure's own catalogue unit code: the payload's `unit` is a storage fact
 * ("milliseconds", "count", "score") that no card prints as is, and which words a column puts beside
 * its numbers is the page's call, the same way it hands in every other string this card shows.
 */
export interface GlanceCardFigure { label: string, unit?: string, figure: GlanceFigure }

// A stable empty list for a card with no chart, so the union below is not rebuilt against a fresh
// `[]` default on every render - the same device Sparkline.tsx's own EMPTY constant uses.
const NO_SOURCES: readonly GlanceStaleSource[] = Object.freeze([])

// Every stale source behind anything this card shows, once each. Keyed on sourceId rather than on
// the name, because two sources can share a display name while being two separate devices that
// each went quiet, and one watch feeding three of the card's figures must still read as one
// sentence rather than the same sentence three times over.
function staleUnion(figures: readonly GlanceCardFigure[], extra: readonly GlanceStaleSource[]): GlanceStaleSource[] {
  const seen = new Map<string, GlanceStaleSource>()
  for (const source of [...figures.flatMap((f) => f.figure.staleSources), ...extra]) {
    if (!seen.has(source.sourceId)) seen.set(source.sourceId, source)
  }
  return [...seen.values()]
}

// The printed value with its unit, or null when the figure has no value yet. A space before the
// unit, the convention StatTile's own `<span> {unit}</span>` and formatWithUnit share.
function valueText(item: GlanceCardFigure, language: string): string | null {
  const value = formatFigure(item.figure, language)
  if (value === null) return null
  return item.unit ? `${value} ${item.unit}` : value
}

// The column's name and its muted span ("so far", "today"), and the stale-source mark beside them.
// A component of its own rather than markup inline in GlanceCard, because the mark arrives through
// Card's context (this card passes Card no label, so Card hands the warning down instead of drawing
// it), and a context is only readable from inside the provider Card renders around its children.
function GlanceTitle({ title, subtitle }: { title: string, subtitle: string | null }) {
  const warning = useUnshownCardWarning()
  return (
    <h2 className="glance-card-title">
      <strong>{title}</strong>{subtitle !== null && <>{' '}<span>{subtitle}</span></>}
      {warning !== null && <SourceWarning text={warning} />}
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

function Headline({ item, today, timezone, night, t, language }: {
  item: GlanceCardFigure
  today: string
  timezone: string
  night: boolean
  t: Translate
  language: string
}) {
  const value = formatFigure(item.figure, language)
  // A figure the payload carries with no value (today's steps before the watch has synced) says so
  // in words under its label rather than printing a zero or a dash in headline type: a big "0"
  // reads as a measured day of nothing, which is the one thing the absence audit never lets a card
  // claim.
  if (value === null) {
    return (
      <div>
        <span className="label">{item.label}</span>
        <p className="glance-empty">{t('glance.noReading')}</p>
      </div>
    )
  }
  const usual = usualLine(item.figure, t, language)
  const asOf = asOfLine(item.figure, { today, timezone, night }, t, language)
  return (
    <div>
      <span className="label">{item.label}</span>
      <div className="value">{value}{item.unit && <span className="glance-unit"> {item.unit}</span>}</div>
      {usual !== null && <p className="basis">{usual}</p>}
      {asOf !== null && <p className="glance-asof">{asOf}</p>}
    </div>
  )
}

/**
 * One column of the glance Dashboard: a question (last night, recovery, today) answered by one
 * headline figure, a chart when the column has one, a few compact secondary figures, the headline's
 * last seven days as a strip, an optional note, and a link to the page that says the rest.
 *
 * Every string a column differs by arrives as a prop, already translated: this card knows how to
 * lay a figure out, and the page knows what each column is called and what its empty day reads.
 */
export function GlanceCard({
  title, subtitle, headline, emptyLine, secondary, stripLabel, stripCaption, chart, chartStaleSources = NO_SOURCES,
  note, link, today, timezone, night = false,
}: {
  title: string
  subtitle: string | null
  /** Null when the column has nothing to show at all, and the card prints `emptyLine` instead. */
  headline: GlanceCardFigure | null
  emptyLine: string
  secondary: GlanceCardFigure[]
  /** The strip's accessible name. */
  stripLabel: string
  /** The visible words under the strip ("last 7 nights"). */
  stripCaption: string
  /** The hypnogram or the heart rate trace. */
  chart?: ReactNode
  /**
   * Stale sources behind `chart`, which is not a GlanceFigure and so carries none of its own: the
   * heart rate trace comes with a staleSources list of its own in the payload, and a quiet watch
   * behind the only chart in a column must still put the mark beside that column's title.
   */
  chartStaleSources?: readonly GlanceStaleSource[]
  /** A line under everything else, such as an elevated breathing rate or why recovery is unscored. */
  note?: string | null
  link: { to: string, text: string }
  today: string
  timezone: string
  /** A sleep column: the as-of line names the night rather than a moment. */
  night?: boolean
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language

  const shown = headline === null ? secondary : [headline, ...secondary]
  const warning = staleSentence(staleUnion(shown, chartStaleSources), t, language)

  // Memoised on the strip itself: Sparkline's chart is rebuilt whenever its values or labels change
  // identity (chart-lifecycle.test.tsx guards exactly that), and arrays mapped fresh here on every
  // render would dispose and re-create the chart each time the page re-rendered for anything else.
  const strip = headline?.figure.strip
  const { values, labels } = useMemo(() => ({
    values: (strip ?? []).map((day) => day.value),
    labels: (strip ?? []).map((day) => day.localDate),
  }), [strip])
  // One reported day is a dot rather than a line, the same judgement RecoveryIndexTile makes for
  // its own sparkline: fewer than two values is not a trend, so the strip and its caption both go.
  const drawStrip = headline !== null && values.filter((value) => value !== null).length > 1

  // The accessible table under the strip formats each day the way the headline prints its value,
  // rather than through the catalogue: two of the glance's metrics (active_minutes and
  // recovery_index) have no catalogue entry at all, and a sleep duration read as a bare count of
  // minutes beside a headline reading "6h 33m" would be the same number said two ways.
  const formatStripValue = (value: number | null, absent: string): string =>
    value === null || headline === null ? absent : formatFigure({ ...headline.figure, value }, language) ?? absent

  return (
    <Card span={4} warning={warning}>
      <div className="glance-card">
        <GlanceTitle title={title} subtitle={subtitle} />
        {headline === null
          ? <p className="glance-empty">{emptyLine}</p>
          : <Headline item={headline} today={today} timezone={timezone} night={night} t={t} language={language} />}
        {chart}
        {secondary.length > 0 && (
          <div className="glance-mini">
            {secondary.map((item) => {
              const usual = usualLine(item.figure, t, language)
              return (
                <div key={item.label}>
                  <span className="label">{item.label}</span>
                  <b>{valueText(item, language) ?? t('glance.noReading')}</b>
                  {usual !== null && <em>{usual}</em>}
                </div>
              )
            })}
          </div>
        )}
        {drawStrip && (
          <Described text={stripCaption}>
            <Sparkline values={values} labels={labels} label={stripLabel} unit={headline.unit ?? headline.label}
              metric={headline.figure.metric} formatValue={formatStripValue} />
          </Described>
        )}
        {note && <p className="glance-note">{note}</p>}
        <Link to={link.to} className="card-link">{link.text}</Link>
      </div>
    </Card>
  )
}
