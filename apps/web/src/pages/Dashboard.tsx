import { useEffect } from 'react'
import { useIsPhone } from '../ui/breakpoint.js'
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
import { CalendarButton } from './dashboard/GlanceCalendar.js'
import { localToday } from '../controls/range.js'
import { dashboardRows } from './dashboard/dashboardRows.js'
import type { DashCardSlot } from './dashboard/dashboardRows.js'
import { formatHeaderDate, formatLongDate, formatTimeOfDay, greetingKey } from './dashboard/glanceText.js'
import { useDashboardDay } from './dashboard/useDashboardDay.js'

// The grid's class by whether its cards are the previous day's, held while the next one loads.
const GRID_CLASS = { settled: 'dashboard-grid', stepping: 'dashboard-grid dashboard-grid-stale' } as const

// The page's heading, in every branch: today greets, a past day is titled with its date. Both are
// known before the glance arrives (the clock and the person's zone, or the day in the URL), so
// loading and error carry the same title rather than flashing a second one.
// On a phone a past day's title is the short date ("Tue, Sep 22"): the long one wrapped to three
// lines beside the four buttons, and the header is one line there (spec M9c, "Phone").
function Title({ timezone, day }: { timezone: string, day: string | null }) {
  const { t, i18n } = useTranslation()
  const isPhone = useIsPhone()
  return <h1 className="dash-title">{day === null ? t(greetingKey(Date.now(), timezone)) : formatHeaderDate(day, i18n.language, isPhone)}</h1>
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
  const { glance, nearest, isPending, isPlaceholderData, isError, error, refetch } = useGlance(urlDay)

  // A day in range with no data: the server names the nearest day that has some, and the page
  // opens that day in place of this one - replacing the URL, so Back does not return to the gap.
  useEffect(() => {
    if (nearest !== null) setDay(nearest, { replace: true })
  }, [nearest, setDay])

  // On its way to the nearest day, the gap's 404 is not an error to show.
  if (isError && nearest === null) return <><Header timezone={timezone} day={urlDay} /><ErrorState onRetry={() => void refetch()} error={error} /></>
  if (isPending || isError || glance === undefined) return <><Header timezone={timezone} day={urlDay} /><Loading /></>

  const { sleep, recovery, day } = glance
  // Stepping to a day not in the cache: `glance` is still the previous day's answer (useGlance's
  // placeholder), so the cards stay put, dimmed, while the header already names the day asked for
  // and the arrows wait for that day's own `nav`. Settled, the header names the day the payload
  // was built for, which is the day every card shows.
  const stepping = isPlaceholderData
  const today = localToday(timezone)
  const shownDay = stepping ? urlDay : glance.finished ? glance.today : null
  // The person's own today, for the calendar's last pickable day and its Today link (setDay turns
  // today into no `?day=` at all, as the header's Today button has it).
  const calendarButton = <CalendarButton selected={shownDay ?? today} today={today} onPick={(picked) => setDay(picked)} />
  const nav = <DayNav glance={glance} onPick={(picked) => setDay(picked)} calendarButton={calendarButton}
    pending={stepping} finished={shownDay !== null} />

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
  // While stepping, the line under the title is the day asked for, not the held cards' span.
  const line = shownDay !== null ? t('glance.dayNav.pastLine')
    : stepping ? formatLongDate(today, language) : <>{formatLongDate(glance.today, language)} · {span}</>
  // A strip's dot or a week bar opens its day, the way the calendar does.
  const card = (slot: DashCardSlot) => {
    switch (slot.kind) {
      case 'night': return <NightCard key="night" sleep={sleep!} span={slot.span} today={glance.today} timezone={timezone} onOpenDay={setDay} finished={finished} />
      case 'recovery': return <RecoveryCard key="recovery" recovery={recovery} span={slot.span} wide={slot.wide} today={glance.today} timezone={timezone} finished={finished} onOpenDay={setDay} />
      case 'today': return <TodayCard key="today" day={day} span={slot.span} today={glance.today} timezone={timezone} finished={finished} onOpenDay={setDay} />
      case 'week': return <WeekCard key="week" glance={glance} span={slot.span} onOpenDay={setDay} />
    }
  }

  return (
    <div className="dashboard">
      <Header timezone={timezone} day={shownDay} nav={nav} line={line} />
      <CardGrid className={stepping ? GRID_CLASS.stepping : GRID_CLASS.settled}>{dashboardRows(glance).flat().map(card)}</CardGrid>
    </div>
  )
}
