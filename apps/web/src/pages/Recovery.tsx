import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { withQuery } from '../router.js'
import { Card } from '../components/Card.js'
import { EmptyState } from '../components/EmptyState.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { ALL_SOURCES } from '../controls/source.js'
import { useRecoveryPeriod } from '../data/usePeriodRead.js'
import type { PeriodStripPoint } from '../data/periodTypes.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { annotationsFor, overridesByMetric } from '../data/chartAnnotations.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { verdictTone } from '../charts/base.js'
import { formatLocalDateRange } from '../format.js'
import { formatLongDate } from './dashboard/glanceText.js'
import { formatFigureValue } from './detail/figureText.js'
import { emphasise, standoutLines, thisPeriod } from './detail/periodText.js'
import { PeriodHero } from './period/PeriodHero.js'
import { PeriodFigureRows } from './period/PeriodFigureRows.js'
import { PointPanel } from './period/PointPanel.js'
import type { PointPanelRow } from './period/PointPanel.js'
import { pointRow, usePeriodShell, usePeriodSource } from './period/usePeriodPage.js'
import { HeartRateCard } from './recovery/HeartRateCard.js'
import { HowTheIndexWorks } from './recovery/HowTheIndexWorks.js'
import { HrvStretchCard } from './recovery/HrvStretchCard.js'
import { contributionRows } from './recovery/contributionRows.js'
import { useRecoveryLabel } from './recovery/labels.js'

// The once-a-day readings the export downloads, the figures' own and the night's breathing the
// server falls back to; the catalogue keeps each of them as 'last'.
const EXPORT_METRICS = ['resting_heart_rate', 'daily_hrv', 'respiratory_rate', 'sleep_respiratory_rate']
// The index is the server's, scored from no series, so there is no year-earlier line to overlay on
// its strip; the comparison with last year is the stood-out line alone.
const LAST_YEAR_GROUPS: readonly MetricGroup[] = []
const HEART_RATE = 'heart_rate'

/** The dashboard on a day: the Day tab's page, and a day point's. */
const dayHref = (localDate: string) => withQuery('/', { day: localDate })

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let cursor = Date.parse(`${from}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return dates
}

/**
 * The Recovery overview: the period's recovery index against the usual for a period that long,
 * what stood out (its highest and lowest days, the change against the period before, and the input
 * that carried it), resting heart rate, HRV and breathing rate under it, HRV against its usual week,
 * the heart rate range, and last how the index works.
 * One read (/recovery/period) the server has already scored, judged, rounded and trimmed; the page
 * only words and draws it (PATTERNS.md's "Overview pages"). The heart rate range keeps its own
 * /series reads, the one card here the period read does not carry.
 *
 * The index (and the HRV stretch beside it) is scored on every source's merged rows whatever
 * source is chosen, as on Sleep's mornings; the figure rows and the heart rate follow the source.
 * With one chosen, a caption under the hero says so, or in its place when the hero draws nothing.
 *
 * The Day tab is no period: it opens the dashboard on that day, as Activity's does. The header, the
 * source, the comparison with last year and the states before there is a period to draw are the
 * overview pages' shared shell (usePeriodSource, usePeriodShell).
 */
export function Recovery() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const page = usePeriodSource(dayHref)
  const { controls, source } = page
  const query = useRecoveryPeriod({ range: controls.tab, anchor: controls.anchor, source })
  const { range, header, alone, gate } = usePeriodShell({
    title: t('recovery.title'), page, query, exportMetrics: EXPORT_METRICS, exportAgg: 'last', lastYearGroups: LAST_YEAR_GROUPS,
  })

  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  // The heart rate range's own marks: its overrides (an excluded reading and its reason). No day
  // notes or events: the overview pages draw none on their charts, and the hero's day panel
  // reaches them.
  const overridesQuery = useAnnotations(range)
  const byMetric = useMemo(() => overridesByMetric(overridesQuery.overrides.data?.items ?? []), [overridesQuery.overrides.data])
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])
  const labelOf = useRecoveryLabel()
  // A figure row's day opens that reading's own panel (exclude, note, event), as the old metric
  // cards did: the index is worked out from these readings, so excluding a bad one is how it
  // leaves the index. Weekly strips hand no clicks (PeriodFigureRows).
  const onFigureDay = useCallback((metric: string, localDate: string) => {
    setAnnotateTarget({ scope: 'day_metric', localDate, metric })
  }, [])

  const { data } = query
  if (gate !== null || data === undefined) return gate
  if (data.hero.days === 0 && data.figures.every((figure) => figure.value === null)) {
    return alone(<EmptyState title={t('recovery.period.emptyTitle')} detail={t('recovery.period.emptyDetail', { days: data.method.baselineDays })} />)
  }

  const { hero } = data
  const weekly = hero.weekly !== null
  const period = thisPeriod(data.period.range, t)
  const heroLabel = t('recovery.period.hero')
  const indexLabel = t('recoveryIndex.label')
  const dayOn = new Map(data.days.map((day) => [day.localDate, day]))

  // A day's panel: its score with its band in words (lower case, as every verdict on this page)
  // and the tone of its own verdict, then its inputs, largest mover first (contributionRows), HRV
  // by the name the rest of the page gives it, the day on the dashboard, and a note or an event
  // on the day (a day target: the index is worked out, never stored, so there is no reading to
  // exclude, and excluding one of its inputs from here would remove that input everywhere). A
  // week's (3 months and Year, where the server sends no days): that week's average with its own
  // verdict in words and tone, as its dot shows it (pointRow, Sleep's week panel), and nowhere to go.
  const panel = (point: PeriodStripPoint, close: () => void) => {
    if (weekly) {
      return (
        <PointPanel title={formatLocalDateRange(point.from, point.to, language)} rows={[pointRow(hero, point, indexLabel, language, t)]}
          open={null} onAnnotate={null} onClose={close} />
      )
    }
    const day = dayOn.get(point.from)
    const score: PointPanelRow = day === undefined
      ? pointRow(hero, point, indexLabel, language, t)
      : {
          label: indexLabel, value: formatFigureValue(hero, day.score, language, t),
          verdict: t(`recovery.period.band.${day.band}`), tone: verdictTone(point.judged, point.standing),
        }
    const inputs = contributionRows(day?.inputs ?? []).map((row): PointPanelRow => ({
      label: row.key === 'hrv' ? t('sleep.night.morning.hrv') : t(`recoveryIndex.input.${row.key}`),
      value: t('recoveryIndex.points', { points: row.points > 0 ? `+${row.points}` : String(row.points) }),
    }))
    return (
      <PointPanel title={formatLongDate(point.from, language)} rows={[score, ...inputs]}
        open={{ to: dayHref(point.from), text: t('recovery.period.panel.openDay') }}
        onAnnotate={() => { close(); setAnnotateTarget({ scope: 'day', localDate: point.from }) }}
        annotateText={t('recovery.period.panel.annotate')}
        onClose={close} />
    )
  }

  const standout = standoutLines({
    figure: hero, high: data.high, low: data.low, previous: data.previous,
    yearEarlier: controls.compareYear === true ? data.yearEarlier : null, highWord: 'highest', language, t,
  })
  // The input the server found carried the period, by the name the morning lists inputs by; none
  // when it found no clear one.
  const carried = data.carriedBy === null ? [] : [
    emphasise(t, 'recovery.period.carriedBy', { input: t(`sleep.night.morning.inputs.${data.carriedBy}`) }, ['input']),
  ]

  const figuresShown = data.figures.some((figure) => figure.value !== null)
  // The source caption speaks for the stretch as well as the index, so it stays when the hero has no
  // value and draws nothing: then it is a card of its own in the hero's place.
  const sourceNote = source === ALL_SOURCES ? null : t('recovery.period.sourceCaption')

  return (
    <div className="detail-page">
      {header}
      <div className="grid">
        <PeriodHero label={heroLabel} figure={hero} noun="day" standout={[...standout, ...carried]}
          caption={weekly ? t('recovery.period.caption.weekly') : t('recovery.period.caption.daily', { period })}
          hint={t(weekly ? 'recovery.period.hint.weekly' : 'recovery.period.hint.daily')}
          note={sourceNote} panel={panel} />
        {hero.value === null && sourceNote !== null && (
          <Card span={12}><p className="dash-caption">{sourceNote}</p></Card>
        )}
        {figuresShown && (
          <Card span={12}>
            <div className="detail-minis">
              <PeriodFigureRows figures={data.figures} labelOf={labelOf} noun="day" onDayClick={onFigureDay} />
            </div>
            <p className="dash-caption">{weekly ? t('recovery.period.lines.weekly') : t('recovery.period.lines.daily', { period })}</p>
          </Card>
        )}
        <HrvStretchCard stretch={data.stretch} method={data.method} />
        <HeartRateCard from={controls.from} to={controls.to} historicalTo={controls.historicalTo} source={source}
          rangeDates={rangeDates} range={data.period.range} period={`${controls.from} ${t('common.to')} ${controls.to}`} periodWords={period}
          annotations={annotationsFor(byMetric, HEART_RATE).annotations}
          excluded={annotationsFor(byMetric, HEART_RATE).excluded}
          onDayClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric: HEART_RATE })}
          span={12} />
        <HowTheIndexWorks method={data.method} />
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </div>
  )
}
