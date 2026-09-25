import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { CardGrid } from '../components/CardGrid.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { useSession } from '../auth/session.js'
import { useGlance } from '../data/useGlance.js'
import { NightCard } from './dashboard/NightCard.js'
import { RecoveryCard } from './dashboard/RecoveryCard.js'
import { TodayCard } from './dashboard/TodayCard.js'
import { WeekCard } from './dashboard/WeekCard.js'
import { DayNav } from './dashboard/DayNav.js'
import { dashboardRows } from './dashboard/dashboardRows.js'
import type { DashCardSlot } from './dashboard/dashboardRows.js'
import { formatLongDate, formatTimeOfDay, greetingKey } from './dashboard/glanceText.js'
import { useDashboardDay } from './dashboard/useDashboardDay.js'

// The page's heading, in every branch: today greets, a past day is titled with its date. Both are
// known before the glance arrives (the clock and the person's zone, or the day in the URL), so
// loading and error carry the same title rather than flashing a second one.
function Title({ timezone, day }: { timezone: string, day: string | null }) {
  const { t, i18n } = useTranslation()
  return <h1 className="dash-title">{day === null ? t(greetingKey(Date.now(), timezone)) : formatLongDate(day, i18n.language)}</h1>
}

// The heading block on the left, the day navigator (when there is a glance to navigate from) on the
// right: one row, which on a phone stays one row, the title wrapping inside its own column.
function Header({ timezone, day, line, nav }: { timezone: string, day: string | null, line?: ReactNode, nav?: ReactNode }) {
  return (
    <div className="dash-header">
      <div className="dash-heading">
        <Title timezone={timezone} day={day} />
        {line !== undefined && <p className="dash-date">{line}</p>}
      </div>
      {nav}
    </div>
  )
}

/**
 * The glance as a home screen: a greeting, the date and span line, then last night beside
 * recovery's dials and today beside the week, in rows dashboardRows.ts decides so that a card
 * with nothing to show never leaves a hole in its row.
 *
 * **No control row**, for the reason Records.tsx gives for its own: every figure here is last night
 * or today by definition, so a range picker would be a control that either lies or does nothing,
 * and a source picker would pick among merged figures the payload has already chosen. The span line
 * under the greeting does the one job the control row did, telling the reader what they are looking
 * at ("last night, and today until 11:40").
 *
 * **One day at a time** (M9c). The header's DayNav steps to the days either side and back to today,
 * the day living in the URL (`?day=`, useDashboardDay). A past day is the same page for a day already
 * over: titled with its date, "that night, and the whole day" under it, and every card in its
 * finished form. Still a day, never a range, so still no control row.
 *
 * **One read.** Everything on the page comes from GET /glance, assembled on the server in the
 * person's own zone, so the cards cannot disagree about which day it is and the phone app
 * (M12) opens on the same answer. The old page's cards each asked for their own range and agg, a
 * dozen requests settling at different moments; the views that lived only here moved to Recovery
 * and Notes rather than disappearing (M9b's first two tasks).
 */
export function Dashboard() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const session = useSession()
  const timezone = session.data?.timezone ?? 'UTC'
  const { day: urlDay, setDay } = useDashboardDay()
  const { glance, nearest, isPending, isError, error, refetch } = useGlance(urlDay)

  // A day in range with no data: the server names the nearest day that has some, and the page
  // opens that day in place of this one - replacing the URL, so Back does not return to the gap.
  useEffect(() => {
    if (nearest !== null) setDay(nearest, { replace: true })
    // setDay is a fresh closure every render and deliberately not a dependency: the redirect is
    // owed once per `nearest`, not once per render.
  }, [nearest])

  // On its way to the nearest day, the gap's 404 is not an error to show.
  if (isError && nearest === null) return <><Header timezone={timezone} day={urlDay} /><ErrorState onRetry={() => void refetch()} error={error} /></>
  if (isPending || isError || glance === undefined) return <><Header timezone={timezone} day={urlDay} /><Loading /></>

  const { sleep, recovery, day } = glance
  // The day the payload was built for, not the URL's: the title names the day every card shows.
  const shownDay = glance.finished ? glance.today : null
  const nav = <DayNav glance={glance} onPick={(picked) => setDay(picked)} />

  // First run, or an archive with nothing in the last day and a half: four cards each saying it
  // has no reading would be the page repeating one fact four times, so it says it once.
  // emptyState.not_synced is not the words for this: that key means the person turned a data type
  // off, which is a different fact.
  const figures = [
    recovery.index, recovery.restingHeartRate, recovery.hrv, recovery.respiratoryRate, day.steps, day.activeMinutes,
  ]
  // A workout is something to show, so a day that holds only a run is not an empty page.
  if (sleep === null && day.heartRate.points.length === 0 && day.workouts.length === 0
    && figures.every((f) => f === null || f.value === null)) {
    return <><Header timezone={timezone} day={shownDay} nav={nav} /><EmptyState title={t('glance.empty.title')} detail={t('glance.empty.detail')} /></>
  }

  // The latest instant anything on the page was read at: the heart rate trace samples most often,
  // and steps stand in on a day the watch sent steps but no heart rate. With no night, the line
  // says so rather than opening on "last night" for a night the page does not have.
  const asOfMs = day.heartRate.asOfMs ?? day.steps.asOfMs
  const time = asOfMs === null ? null : formatTimeOfDay(asOfMs, language, timezone)
  const span = sleep === null
    ? (time === null ? t('glance.spanNoNightNoTime') : t('glance.spanNoNight', { time }))
    : (time === null ? t('glance.spanNoTime') : t('glance.span', { time }))

  const finished = glance.finished
  const card = (slot: DashCardSlot) => {
    switch (slot.kind) {
      case 'night': return <NightCard key="night" sleep={sleep!} span={slot.span} today={glance.today} timezone={timezone} />
      case 'recovery': return <RecoveryCard key="recovery" recovery={recovery} span={slot.span} wide={slot.wide} today={glance.today} timezone={timezone} finished={finished} />
      case 'today': return <TodayCard key="today" day={day} span={slot.span} today={glance.today} timezone={timezone} finished={finished} />
      case 'week': return <WeekCard key="week" glance={glance} span={slot.span} />
    }
  }

  return (
    <div className="dashboard">
      <Header timezone={timezone} day={shownDay} nav={nav}
        line={finished ? t('glance.dayNav.pastLine') : <>{formatLongDate(glance.today, language)} · {span}</>} />
      <CardGrid className="dashboard-grid">{dashboardRows(glance).flat().map(card)}</CardGrid>
    </div>
  )
}
