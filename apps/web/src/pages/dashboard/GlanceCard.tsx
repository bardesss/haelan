import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { GlanceFigure, GlanceStaleSource } from '../../data/useGlance.js'
import { Card } from '../../components/Card.js'
import { staleSentence } from '../../components/staleSentence.js'
import { Sparkline } from '../../charts/Sparkline.js'
import { Link } from '../../router.js'
import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { formatFigure, usualLine, asOfLine } from './glanceText.js'
import { Described, DashTitle, staleUnion, NO_SOURCES } from './cardShared.js'

/**
 * One figure as a glance card prints it. `unit` is display text the page has already translated
 * ("bpm", "min"), not the figure's own catalogue unit code: the payload's `unit` is a storage fact
 * ("milliseconds", "count", "score") that no card prints as is, and which words a column puts beside
 * its numbers is the page's call, the same way it hands in every other string this card shows.
 */
export interface GlanceCardFigure {
  label: string
  unit?: string
  figure: GlanceFigure
  /**
   * What stands in for the usual line when the figure has no baseline of its own to compare with:
   * the recovery index is already a comparison with the person's usual (core sends it with
   * `baseline: null`), so its band wording ("Around your usual") is the line that goes under it.
   * Ignored whenever `usualLine` has something to say.
   */
  usual?: string
}

// The printed value with its unit, or null when the figure has no value yet. A space before the
// unit, the convention StatTile's own `<span> {unit}</span>` and formatWithUnit share.
function valueText(item: GlanceCardFigure, language: string): string | null {
  const value = formatFigure(item.figure, language)
  if (value === null) return null
  return item.unit ? `${value} ${item.unit}` : value
}

function Headline({ item, today, timezone, night, dayInSubtitle, t, language }: {
  item: GlanceCardFigure
  today: string
  timezone: string
  night: boolean
  dayInSubtitle: boolean
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
  const usual = usualLine(item.figure, t, language) ?? item.usual ?? null
  // No as-of line when the column's subtitle already names the headline's day: "today" above the
  // title and "today" again under the number, or the night's dates and then "night of 23 Sep", was
  // the card saying one day twice.
  const asOf = dayInSubtitle ? null : asOfLine(item.figure, { today, timezone, night }, t, language)
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
  extra, note, link, today, timezone, night = false, dayInSubtitle = false,
}: {
  title: string
  subtitle: string | null
  /**
   * The subtitle names the headline's own day (Recovery's "today", Sleep's night), so the headline
   * prints no as-of line of its own. Secondary figures still name theirs when it differs.
   */
  dayInSubtitle?: boolean
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
  /**
   * Anything a column lists under its figures, such as today's workouts in the today column. Its
   * own component decides whether it renders at all, so a column with nothing to list draws the
   * same card it always did.
   */
  extra?: ReactNode
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
  const warning = staleSentence(staleUnion(shown.map((f) => f.figure), chartStaleSources), t, language)

  // Memoised on the strip itself: Sparkline's chart is rebuilt whenever its values or labels change
  // identity (chart-lifecycle.test.tsx guards exactly that), and arrays mapped fresh here on every
  // render would dispose and re-create the chart each time the page re-rendered for anything else.
  const strip = headline?.figure.strip
  const { values, labels } = useMemo(() => ({
    values: (strip ?? []).map((day) => day.value),
    labels: (strip ?? []).map((day) => day.localDate),
  }), [strip])
  // One reported day is a dot rather than a line: fewer than two values is not a trend, so the
  // strip and its caption both go.
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
        <div className="glance-card-head"><DashTitle title={title} subtitle={subtitle} /></div>
        {headline === null
          ? <p className="glance-empty">{emptyLine}</p>
          : <Headline item={headline} today={today} timezone={timezone} night={night}
            dayInSubtitle={dayInSubtitle} t={t} language={language} />}
        {chart}
        {secondary.length > 0 && (
          <div className="glance-mini">
            {secondary.map((item) => {
              const usual = usualLine(item.figure, t, language) ?? item.usual ?? null
              // A pair names its own day only when it differs from the headline's, or when the
              // headline names none: core falls back to yesterday separately for each recovery
              // figure, so a card whose index is yesterday's can carry today's resting heart rate,
              // and the column's one subtitle would otherwise speak for a figure it does not cover.
              const headlineDate = headline?.figure.value === null ? null : headline?.figure.asOfDate ?? null
              const asOf = headlineDate === null || item.figure.asOfDate !== headlineDate
                ? asOfLine(item.figure, { today, timezone, night }, t, language)
                : null
              return (
                <div key={item.label}>
                  <span className="label">{item.label}</span>
                  <b>{valueText(item, language) ?? t('glance.noReading')}</b>
                  {usual !== null && <em>{usual}</em>}
                  {asOf !== null && <span className="glance-asof">{asOf}</span>}
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
        {extra}
        {note && <p className="glance-note">{note}</p>}
        <Link to={link.to} className="card-link">{link.text}</Link>
      </div>
    </Card>
  )
}
