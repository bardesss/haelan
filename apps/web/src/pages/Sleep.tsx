import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { METRICS } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { navigate } from '../router.js'
import { Card } from '../components/Card.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { PageHeader } from '../components/PageHeader.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { useSleepPeriod } from '../data/useSleepPeriod.js'
import type { PeriodFigure, PeriodStripPoint } from '../data/periodTypes.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { annotationsFor, overridesByMetric } from '../data/chartAnnotations.js'
import { useLastYear } from '../data/lastYear.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { exportPathFor } from '../data/pageShell.js'
import { formatClock, formatLocalDateRange, formatLongWeekdayDate } from '../format.js'
import { formatFigureValue } from './detail/figureText.js'
import { pointVerdictWords, standoutLines, thisPeriod } from './detail/periodText.js'
import { verdictTone } from '../charts/base.js'
import { PeriodHero } from './period/PeriodHero.js'
import { PeriodFigureRows } from './period/PeriodFigureRows.js'
import { PointPanel } from './period/PointPanel.js'
import type { PointPanelRow } from './period/PointPanel.js'
import { LIST_VISIBLE } from './period/ExpandableList.js'
import { periodLine } from './period/periodLine.js'
import { useNightHref } from './sleep/NightRow.js'
import { useSleepLabel } from './sleep/period/labels.js'
import { SleepStages } from './sleep/period/SleepStages.js'
import { SleepScheduleCard, hasSchedule } from './sleep/period/SleepScheduleCard.js'
import { SleepNightsList } from './sleep/period/SleepNightsList.js'
import { SleepBalanceCard, hasBalance } from './sleep/period/SleepBalanceCard.js'
import { SleepMornings, hasFigures } from './sleep/period/SleepMornings.js'
import { SleepMore } from './sleep/period/SleepMore.js'

// The daily rollups the export downloads: the summed sleep figures, those the catalogue sums.
const EXPORT_METRICS = [
  'sleep_asleep_minutes', 'sleep_deep_minutes', 'sleep_light_minutes', 'sleep_rem_minutes',
  'sleep_awake_minutes', 'sleep_in_bed_minutes', 'sleep_nap_minutes',
].filter((metric) => METRICS[metric]?.aggs.includes('sum') ?? false)

// Compare with last year reads time asleep alone: the hero's strip is the one line it overlays.
const LAST_YEAR_GROUPS: readonly MetricGroup[] = [{ agg: 'sum', metrics: ['sleep_asleep_minutes'] }]
const ASLEEP = 'sleep_asleep_minutes'
const NO_DATES: string[] = Object.freeze([]) as never[]

/**
 * The Sleep overview (M10b): the period's time asleep against the usual for a period that long,
 * what stood out, the four figures under it, then the nights' stages, the schedule beside the list
 * of nights, the balance beside the mornings, and the rest. One read (/sleep/period) the server has
 * already judged, rounded and trimmed; the page only words and draws it (PATTERNS.md's "Overview
 * pages"). /sleep/nights is asked only on Week and Month, for the naps on the schedule chart, and
 * /series only for the comparison with last year, while it is on.
 *
 * The Day tab is no period: it opens that date's night page, keeping the reader's source.
 *
 * The source is resolved against the sources this person has before anything is asked (the rule
 * every page keeps): the server answers an unknown one with a 400, and a stale link should read as
 * all sources, not as an error.
 */
// The figures a night's panel lists under its time asleep, the mockup's: efficiency, deep sleep, bedtime.
const PANEL_METRICS: readonly string[] = ['sleep_efficiency', 'sleep_deep_minutes', 'sleep_bedtime_minutes']

export function Sleep() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const session = useSession()
  const controls = usePageControls()
  const { sources: named, nameOf } = useSourceNames()
  const sources = useMemo(() => named.map((source) => source.id), [named])
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const resolved = { ...controls, source }
  const range = { from: controls.from, to: controls.to, source }
  const isDay = controls.tab === 'day'

  // The night page for a date, keeping the source the reader named in the URL (useOpenNight's rule).
  const nightHref = useNightHref()
  const dayTarget = isDay ? nightHref(controls.anchor) : null
  useEffect(() => {
    if (dayTarget !== null) navigate(dayTarget, { replace: true })
  }, [dayTarget])

  const query = useSleepPeriod({ range: controls.tab, anchor: controls.anchor, source })
  const data = query.data

  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const overridesQuery = useAnnotations(range)
  const overrides = useMemo(
    () => annotationsFor(overridesByMetric(overridesQuery.overrides.data?.items ?? []), ASLEEP),
    [overridesQuery.overrides.data],
  )

  const heroDates = useMemo(() => data?.hero.daily.map((point) => point.from) ?? NO_DATES, [data])
  // Ended at historicalTo: a month six days old is set against the same six days a year earlier.
  // Asked on Week and Month only: on 3 months and Year the strip is weekly and draws no overlay.
  const overlaid = controls.tab === 'week' || controls.tab === 'month'
  const lastYear = useLastYear(LAST_YEAR_GROUPS, { ...range, to: controls.historicalTo }, heroDates, controls.compareYear === true && overlaid)

  // The list's expansion belongs to the period it was opened in: a new period opens collapsed.
  const periodKey = `${controls.tab}:${controls.from}:${source}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const expanded = expandedFor === periodKey

  const labelOf = useSleepLabel()
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, EXPORT_METRICS, 'sum', range) : undefined
  const sourceName = source === ALL_SOURCES ? t('controlRow.sourceAll') : nameOf(source)

  const header = (
    <>
      <PageHeader title={t('sleep.title')} line={periodLine(controls.from, controls.to, sourceName, language)} />
      <ControlRow controls={resolved} sources={sources} exportPath={exportPath} yearCompare />
    </>
  )
  // A detail page's root (PATTERNS.md's page shell), for its card-label gap and width, in every state.
  const alone = (body: ReactNode) => <div className="detail-page">{header}<div className="grid"><Card span={12}>{body}</Card></div></div>

  if (isDay) return <div className="detail-page">{header}</div>
  if (query.isError) return alone(<ErrorState onRetry={() => void query.refetch()} error={query.error} />)
  if (data === undefined) return alone(<Loading />)
  if (data.hero.days === 0) return alone(<EmptyState title={t('sleep.nights.emptyTitle')} detail={t('sleep.nights.emptyDetail')} />)

  const { hero } = data
  const weekly = hero.weekly !== null
  const heroLabel = t('sleep.period.hero.label')
  const period = thisPeriod(data.period.range, t)
  const nightOn = new Map(data.nights.map((night) => [night.localDate, night]))

  // A point's row: its figure's value and that point's own verdict, in its tone (the server's).
  const rowOf = (figure: PeriodFigure, point: PeriodStripPoint): PointPanelRow => ({
    label: labelOf(figure.metric), value: formatFigureValue(figure, point.value, language, t),
    verdict: pointVerdictWords(point.standing, figure.unit, t), tone: verdictTone(point.judged, point.standing),
  })

  // A day's panel, the approved mockup's: the night's bed and wake under its date, then its time
  // asleep, efficiency, deep sleep and bedtime, each with that night's verdict, the way to its page,
  // and the day-metric exclude and annotate, which closes the panel as the AnnotatePanel opens. A
  // week's: that week's time asleep alone, and nowhere to go (the other figures carry only their
  // weeks on these ranges).
  const panel = (point: PeriodStripPoint, close: () => void) => {
    const asleep = { ...rowOf(hero, point), label: t('sleep.night.hero.label') }
    if (weekly) {
      return <PointPanel title={formatLocalDateRange(point.from, point.to, language)} rows={[asleep]} open={null} onAnnotate={null} onClose={close} />
    }
    const night = nightOn.get(point.from)
    const times = [
      night?.bedtimeMinutes == null ? null : t('sleep.period.panel.bed', { time: formatClock(night.bedtimeMinutes) }),
      night?.waketimeMinutes == null ? null : t('sleep.period.panel.wake', { time: formatClock(night.waketimeMinutes) }),
    ].filter((part) => part !== null)
    const rows = [asleep, ...data.figures.filter((figure) => PANEL_METRICS.includes(figure.metric)).flatMap((figure) => {
      const own = figure.daily.find((p) => p.from === point.from)
      return own === undefined || own.value === null ? [] : [rowOf(figure, own)]
    })]
    return (
      <PointPanel title={formatLongWeekdayDate(point.from, language)} subtitle={times.length === 0 ? null : times.join(' · ')} rows={rows}
        open={{ to: nightHref(point.from), text: t('sleep.openNight') }}
        onAnnotate={() => { close(); setAnnotateTarget({ scope: 'day_metric', localDate: point.from, metric: ASLEEP }) }}
        onClose={close} />
    )
  }

  const standout = standoutLines({
    figure: hero, high: data.high, previous: data.previous, yearEarlier: controls.compareYear === true ? data.yearEarlier : null,
    highWord: 'longest', language, t,
  })

  // Two half cards share a row; either alone takes the whole of it, and the list expanded takes a row
  // of its own, its partner widening with it, so no hole opens (PATTERNS.md's "Overview pages").
  const scheduleShown = hasSchedule(data.schedule)
  const listShown = data.nights.length > 0
  const listOpen = expanded && data.nights.length > LIST_VISIBLE
  const nightsSpan = scheduleShown && listShown && !listOpen ? 6 : 12
  const balanceShown = hasBalance(data.balance)
  const morningsShown = hasFigures(data.mornings)
  const morningSpan = balanceShown && morningsShown ? 6 : 12

  return (
    <div className="detail-page">
      {header}
      <div className="grid">
        <PeriodHero label={heroLabel} figure={hero} noun="night" standout={standout}
          caption={weekly ? t('sleep.period.caption.weekly') : t('sleep.period.caption.daily', { period })}
          hint={t(weekly ? 'sleep.period.hint.weekly' : 'sleep.period.hint.daily')}
          lastYear={lastYear.alignedOf(ASLEEP)} panel={panel} />
        {hasFigures(data.figures) && (
          <Card span={12}>
            <div className="detail-minis">
              <PeriodFigureRows figures={data.figures} labelOf={labelOf} noun="night" />
            </div>
            <p className="dash-caption">{weekly ? t('sleep.period.lines.weeklyNights') : t('sleep.period.lines.nights', { period })}</p>
          </Card>
        )}
        <SleepStages stages={data.stages} range={data.period.range} />
        {scheduleShown && (
          <SleepScheduleCard data={data} range={data.period.range} span={nightsSpan}
            nightsRange={{ from: data.period.from, to: data.period.to, source }} />
        )}
        {listShown && (
          <SleepNightsList nights={data.nights} months={data.months} range={data.period.range} longest={data.high?.localDate ?? null} span={nightsSpan} expanded={expanded}
            onToggle={() => setExpandedFor(expanded ? null : periodKey)} />
        )}
        {balanceShown && data.balance !== null && (
          <SleepBalanceCard balance={data.balance} range={data.period.range} dates={heroDates} nights={hero.days} span={morningSpan}
            excluded={overrides.excluded} annotations={overrides.annotations}
            onPointClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric: ASLEEP })} />
        )}
        {morningsShown && <SleepMornings figures={data.mornings} range={data.period.range} span={morningSpan} />}
        {hasFigures(data.more) && <SleepMore figures={data.more} />}
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </div>
  )
}
