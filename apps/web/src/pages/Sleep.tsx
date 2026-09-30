import { useMemo, useState } from 'react'
import { METRICS } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { EmptyState } from '../components/EmptyState.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { useSleepPeriod } from '../data/useSleepPeriod.js'
import type { PeriodFigure, PeriodStripPoint } from '../data/periodTypes.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { annotationsFor, overridesByMetric } from '../data/chartAnnotations.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { formatClock, formatLocalDateRange } from '../format.js'
import { formatLongDate } from './dashboard/glanceText.js'
import { standoutLines, thisPeriod } from './detail/periodText.js'
import { PeriodHero } from './period/PeriodHero.js'
import { PeriodFigureRows } from './period/PeriodFigureRows.js'
import { PointPanel } from './period/PointPanel.js'
import { LIST_VISIBLE } from './period/ExpandableList.js'
import { pointRow, usePeriodShell, usePeriodSource } from './period/usePeriodPage.js'
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

// The figures a night's panel lists under its time asleep, the mockup's: efficiency, deep sleep, bedtime.
const PANEL_METRICS: readonly string[] = ['sleep_efficiency', 'sleep_deep_minutes', 'sleep_bedtime_minutes']

/**
 * The Sleep overview (M10b): the period's time asleep against the usual for a period that long,
 * what stood out, the four figures under it, then the nights' stages, the schedule beside the list
 * of nights, the balance beside the mornings, and the rest. One read (/sleep/period) the server has
 * already judged, rounded and trimmed; the page only words and draws it (PATTERNS.md's "Overview
 * pages"). /sleep/nights is asked only on Week and Month, for the naps on the schedule chart, and
 * /series only for the comparison with last year, while it is on.
 *
 * The Day tab is no period: it opens that date's night page, keeping the reader's source. The
 * header, the source, the comparison with last year, the list's expansion and the states before
 * there is a period to draw are the overview pages' shared shell (usePeriodSource, usePeriodShell).
 */
export function Sleep() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // The night page for a date, keeping the source the reader named in the URL (useOpenNight's rule).
  const nightHref = useNightHref()
  const page = usePeriodSource(nightHref)
  const { controls, source } = page
  const query = useSleepPeriod({ range: controls.tab, anchor: controls.anchor, source })
  const { range, heroDates, lastYear, periodKey, expanded, toggle, header, alone, gate } = usePeriodShell({
    title: t('sleep.title'), page, query, exportMetrics: EXPORT_METRICS, lastYearGroups: LAST_YEAR_GROUPS,
  })

  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const overridesQuery = useAnnotations(range)
  const overrides = useMemo(
    () => annotationsFor(overridesByMetric(overridesQuery.overrides.data?.items ?? []), ASLEEP),
    [overridesQuery.overrides.data],
  )
  const labelOf = useSleepLabel()

  const { data } = query
  if (gate !== null || data === undefined) return gate
  if (data.hero.days === 0) return alone(<EmptyState title={t('sleep.nights.emptyTitle')} detail={t('sleep.nights.emptyDetail')} />)

  const { hero } = data
  const weekly = hero.weekly !== null
  const heroLabel = t('sleep.period.hero.label')
  const period = thisPeriod(data.period.range, t)
  const nightOn = new Map(data.nights.map((night) => [night.localDate, night]))

  const rowOf = (figure: PeriodFigure, point: PeriodStripPoint) => pointRow(figure, point, labelOf(figure.metric), language, t)

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
      <PointPanel title={formatLongDate(point.from, language)} subtitle={times.length === 0 ? null : times.join(' · ')} rows={rows}
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
          <SleepNightsList nights={data.nights} months={data.months} range={data.period.range} longest={data.high?.localDate ?? null}
            span={nightsSpan} expanded={expanded} onToggle={toggle} />
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
