import { useCallback, useState } from 'react'
import { METRICS } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { navigate, withQuery } from '../router.js'
import { Card } from '../components/Card.js'
import { EmptyState } from '../components/EmptyState.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { useActivityPeriod } from '../data/usePeriodRead.js'
import type { PeriodFigure, PeriodStripPoint } from '../data/periodTypes.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { formatLocalDateRange } from '../format.js'
import { formatLongDate } from './dashboard/glanceText.js'
import { standoutLines, thisPeriod } from './detail/periodText.js'
import { PeriodHero } from './period/PeriodHero.js'
import { PeriodFigureRows } from './period/PeriodFigureRows.js'
import { PointPanel } from './period/PointPanel.js'
import { LIST_VISIBLE } from './period/ExpandableList.js'
import { pointRow, usePeriodShell, usePeriodSource } from './period/usePeriodPage.js'
import { useActivityLabel, useActivityName } from './activity/period/labels.js'
import { ActivityHeatmapCard } from './activity/period/ActivityHeatmapCard.js'
import { ActivityIntensity, hasIntensity } from './activity/period/ActivityIntensity.js'
import { ActivityZoneMinutes, hasZoneMinutes, ZONE_MINUTES_METRIC } from './activity/period/ActivityZoneMinutes.js'
import { ActivityHeartZones, hasHeartZones } from './activity/period/ActivityHeartZones.js'
import { ActivityWorkouts } from './activity/period/ActivityWorkouts.js'
import { ActivityTypes, hasTypes } from './activity/period/ActivityTypes.js'
import { ActivityMore } from './activity/period/ActivityMore.js'

// The daily rollups the export downloads: the page's summed activity figures, those the catalogue sums.
const EXPORT_METRICS = [
  'steps', 'distance', 'floors', 'total_calories', 'active_energy',
  'active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous',
  'active_zone_minutes_fat_burn', 'active_zone_minutes_cardio', 'active_zone_minutes_peak',
  'workout_minutes',
].filter((metric) => METRICS[metric]?.aggs.includes('sum') ?? false)

// Compare with last year reads steps alone: the hero's strip is the one line it overlays.
const STEPS = 'steps'
const LAST_YEAR_GROUPS: readonly MetricGroup[] = [{ agg: 'sum', metrics: [STEPS] }]
// The figures a day's panel lists under its steps, the brief's: active minutes and distance.
const PANEL_METRICS: readonly string[] = ['active_minutes', 'distance']
const WORKOUT_TIME = 'workout_minutes'

/** The dashboard on a day: the Day tab's page, and a day point's. */
const dayHref = (localDate: string) => withQuery('/', { day: localDate })

/**
 * The Activity overview (M10b): the period's steps against the usual for a period that long, what
 * stood out, the four figures under it, then (on 3 months and Year) every day's steps as a
 * heatmap, the active minutes by intensity, the zone minutes beside the heart-rate zones, the
 * workouts beside their types, and the rest. One read (/activity/period) the server has already
 * judged, rounded and trimmed; the page only words and draws it (PATTERNS.md's "Overview pages").
 * /series is asked only for the comparison with last year, while it is on.
 *
 * The Day tab is no period: it opens the dashboard on that day. The dashboard reads no source, so
 * none is carried. The header, the source, the comparison with last year, the list's expansion and
 * the states before there is a period to draw are the overview pages' shared shell
 * (usePeriodSource, usePeriodShell).
 */
export function Activity() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const page = usePeriodSource(dayHref)
  const { controls, source } = page
  const query = useActivityPeriod({ range: controls.tab, anchor: controls.anchor, source })
  const { lastYear, periodKey, expanded, toggle, header, alone, gate } = usePeriodShell({
    title: t('activity.title'), page, query, exportMetrics: EXPORT_METRICS, lastYearGroups: LAST_YEAR_GROUPS,
  })

  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const labelOf = useActivityLabel()
  const nameOfMetric = useActivityName()
  const openDay = useCallback((localDate: string) => navigate(dayHref(localDate)), [])

  const { data } = query
  if (gate !== null || data === undefined) return gate
  if (data.hero.days === 0 && data.workouts.length === 0) {
    return alone(<EmptyState title={t('activity.sessions.emptyPeriodTitle')} detail={t('activity.sessions.emptyPeriodDetail')} />)
  }

  const { hero } = data
  const weekly = hero.weekly !== null
  const period = thisPeriod(data.period.range, t)

  const rowOf = (figure: PeriodFigure, point: PeriodStripPoint) => pointRow(figure, point, nameOfMetric(figure.metric), language, t)

  // A day's panel: its steps, active minutes and distance from the figures' own daily points, each
  // with that day's verdict, the way to the day on the dashboard, and the day-metric exclude and
  // annotate on steps, which closes the panel as the AnnotatePanel opens. A week's: that week's
  // steps alone, and nowhere to go (the other figures carry only their weeks on these ranges).
  const panel = (point: PeriodStripPoint, close: () => void) => {
    const steps = rowOf(hero, point)
    if (weekly) {
      return <PointPanel title={formatLocalDateRange(point.from, point.to, language)} rows={[steps]} open={null} onAnnotate={null} onClose={close} />
    }
    const rows = [steps, ...PANEL_METRICS.flatMap((metric) => {
      const figure = data.figures.find((f) => f.metric === metric)
      const own = figure?.daily.find((p) => p.from === point.from)
      return figure === undefined || own === undefined || own.value === null ? [] : [rowOf(figure, own)]
    })]
    return (
      <PointPanel title={formatLongDate(point.from, language)} rows={rows}
        open={{ to: dayHref(point.from), text: t('activity.period.openDay') }}
        onAnnotate={() => { close(); setAnnotateTarget({ scope: 'day_metric', localDate: point.from, metric: STEPS }) }}
        onClose={close} />
    )
  }

  const standout = standoutLines({
    figure: hero, high: data.high, previous: data.previous, yearEarlier: controls.compareYear === true ? data.yearEarlier : null,
    highWord: 'busiest', language, t, perDay: true,
  })

  // Two half cards share a row; either alone takes the whole of it, and the list expanded takes a row
  // of its own, its partner widening with it, so no hole opens (PATTERNS.md's "Overview pages").
  const zonesShown = hasZoneMinutes(data.zoneMinutes)
  const heartShown = hasHeartZones(data.heartRateZones, data.maxHeartRate)
  const zoneSpan = zonesShown && heartShown ? 6 : 12
  const listShown = data.workouts.length > 0
  const typesShown = hasTypes(data.types, data.cardioLoad, data.vo2max)
  const listOpen = expanded && data.workouts.length > LIST_VISIBLE
  const workoutSpan = listShown && typesShown && !listOpen ? 6 : 12
  const figuresShown = data.figures.some((figure) => figure.value !== null)

  return (
    <div className="detail-page">
      {header}
      <div className="grid">
        <PeriodHero label={t('activity.period.hero')} figure={hero} noun="day" standout={standout}
          caption={weekly ? t('activity.period.caption.weekly', { count: hero.weekly!.length }) : t('activity.period.caption.daily', { period })}
          hint={t(weekly ? 'activity.period.hint.weekly' : 'activity.period.hint.daily')}
          lastYear={lastYear.alignedOf(STEPS)} panel={panel} />
        {figuresShown && (
          <Card span={12}>
            <div className="detail-minis">
              <PeriodFigureRows figures={data.figures} labelOf={labelOf} noun="day" />
            </div>
            <p className="dash-caption">{weekly ? t('activity.period.lines.weekly') : t('activity.period.lines.daily', { period })}</p>
          </Card>
        )}
        <ActivityHeatmapCard steps={hero} high={data.high} range={data.period.range} onOpenDay={openDay} />
        {hasIntensity(data.intensity) && <ActivityIntensity intensity={data.intensity} range={data.period.range} />}
        {zonesShown && (
          <ActivityZoneMinutes zones={data.zoneMinutes} total={data.more.find((figure) => figure.metric === ZONE_MINUTES_METRIC) ?? null}
            range={data.period.range} span={zoneSpan} />
        )}
        {heartShown && <ActivityHeartZones zones={data.heartRateZones} maxHeartRate={data.maxHeartRate} range={data.period.range} span={zoneSpan} />}
        {listShown && (
          <ActivityWorkouts key={periodKey} workouts={data.workouts} workoutMonths={data.workoutMonths} types={data.types} workoutCount={data.workoutCount}
            workoutTime={data.more.find((figure) => figure.metric === WORKOUT_TIME) ?? null}
            range={data.period.range} span={workoutSpan} expanded={expanded} onToggle={toggle} />
        )}
        {typesShown && <ActivityTypes types={data.types} cardioLoad={data.cardioLoad} vo2max={data.vo2max} range={data.period.range} span={workoutSpan} />}
        <ActivityMore figures={data.more} workoutCount={data.workoutCount} />
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </div>
  )
}
