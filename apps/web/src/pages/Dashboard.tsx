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
import { dashboardRows } from './dashboard/dashboardRows.js'
import type { DashCardSlot } from './dashboard/dashboardRows.js'
import { formatTimeOfDay, greetingKey } from './dashboard/glanceText.js'

// The greeting as the page's heading, in every branch: the clock and the person's zone are known
// before the glance arrives, so loading and error greet too rather than flashing a second title.
function Title({ timezone }: { timezone: string }) {
  const { t } = useTranslation()
  return <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-1)' }}>{t(greetingKey(Date.now(), timezone))}</h1>
}

// The glance's own today as a long date ("Wednesday, September 23"). The payload's date rather than
// the browser's clock, so the line names the same day every card on the page was assembled for; it
// is already the person's local date, so it is anchored at UTC midnight and read back in UTC, the
// convention formatLocalDate uses, and no zone can move it onto a neighbouring day.
function longDate(localDate: string, language: string): string {
  return new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${localDate}T00:00:00Z`))
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
  const { glance, isPending, isError, error, refetch } = useGlance()

  if (isError) return <><Title timezone={timezone} /><ErrorState onRetry={() => void refetch()} error={error} /></>
  if (isPending || glance === undefined) return <><Title timezone={timezone} /><Loading /></>

  const { sleep, recovery, day } = glance

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
    return <><Title timezone={timezone} /><EmptyState title={t('glance.empty.title')} detail={t('glance.empty.detail')} /></>
  }

  // The latest instant anything on the page was read at: the heart rate trace samples most often,
  // and steps stand in on a day the watch sent steps but no heart rate. With no night, the line
  // says so rather than opening on "last night" for a night the page does not have.
  const asOfMs = day.heartRate.asOfMs ?? day.steps.asOfMs
  const time = asOfMs === null ? null : formatTimeOfDay(asOfMs, language, timezone)
  const span = sleep === null
    ? (time === null ? t('glance.spanNoNightNoTime') : t('glance.spanNoNight', { time }))
    : (time === null ? t('glance.spanNoTime') : t('glance.span', { time }))

  const card = (slot: DashCardSlot) => {
    switch (slot.kind) {
      case 'night': return <NightCard key="night" sleep={sleep!} span={slot.span} today={glance.today} timezone={timezone} />
      case 'recovery': return <RecoveryCard key="recovery" recovery={recovery} span={slot.span} wide={slot.wide} today={glance.today} timezone={timezone} />
      case 'today': return <TodayCard key="today" day={day} span={slot.span} timezone={timezone} />
      case 'week': return <WeekCard key="week" glance={glance} span={slot.span} />
    }
  }

  return (
    <div className="dashboard">
      <Title timezone={timezone} />
      <p className="dash-date">{longDate(glance.today, language)} · {span}</p>
      <CardGrid className="dashboard-grid">{dashboardRows(glance).flat().map(card)}</CardGrid>
    </div>
  )
}
