import { useMemo } from 'react'
import { useTranslation } from '../i18n/index.js'
import { CardGrid } from '../components/CardGrid.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { IntradayHeartRate } from '../charts/IntradayHeartRate.js'
import { localMinutesOf, inWindow, DEFAULT_WINDOW } from '../charts/schedule.js'
import { useSession } from '../auth/session.js'
import { useGlance } from '../data/useGlance.js'
import type { GlanceSleep } from '../data/useGlance.js'
import { stageOf } from '../data/nights.js'
import { formatClock } from '../format.js'
import { GlanceCard } from './dashboard/GlanceCard.js'
import { Described } from './dashboard/cardShared.js'
import { TodayWorkouts } from './dashboard/TodayWorkouts.js'
import { formatFigure, formatTimeOfDay, yesterdayOf } from './dashboard/glanceText.js'

// Hypnogram's own Stage type lives in the July fixtures module, which this page cannot import
// (see the "does not import the fixtures" test): a local, structurally identical union avoids
// that import for the one type this file needs from it.
type Stage = 'deep' | 'light' | 'rem' | 'awake'
type Segment = { stage: Stage, startMs: number, endMs: number }

// One frozen empty list for the no-night case, so the memo below hands the chart the same identity
// on every render rather than a fresh `[]`, which useChart reads as a reason to rebuild.
const NO_SEGMENTS: Segment[] = Object.freeze([]) as never[]

// The night's segments made relative to its own start, which is the frame Hypnogram draws in.
// startMs/endMs stay raw milliseconds rather than minutes: Hypnogram's stageTotals sums them for the
// totals row, and rounding each boundary first let two roundings compound into minutes of drift
// against derive/sleep.ts's own single-rounded figure (see Hypnogram.tsx's comment on `segments`).
function hypnogramSegments(sleep: GlanceSleep | null): Segment[] {
  if (sleep === null) return NO_SEGMENTS
  return sleep.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - sleep.startMs, endMs: s.endMs - sleep.startMs }))
    .filter((s): s is Segment => s.stage !== null)
}

// The night's dates as the column's subtitle ("Sat 5 – Sun 6 Sep"), read in the person's zone.
// formatRange rather than two formatted dates joined by hand: the language decides how a range
// collapses a shared month, and a night that starts after midnight comes out as one date.
function nightSpan(sleep: GlanceSleep, language: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short', timeZone })
  return format.formatRange(new Date(sleep.startMs), new Date(sleep.endMs))
}

function Title() {
  const { t } = useTranslation()
  return <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
}

/**
 * The glance: last night, recovery and today so far, one card per question, from one read, and
 * inside the today column today's workouts when there are any (TodayWorkouts.tsx).
 *
 * **No control row**, for the reason Records.tsx gives for its own: every figure here is last night
 * or today by definition, so a range picker would be a control that either lies or does nothing,
 * and a source picker would pick among merged figures the payload has already chosen. The span line
 * under the title does the one job the control row did, telling the reader what they are looking
 * at ("Last night, and today until 11:40").
 *
 * **One read.** Everything on the page comes from GET /glance, assembled on the server in the
 * person's own zone, so the three columns cannot disagree about which day it is and the phone app
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

  // Above the early returns, so the hook order is the same on every render. Keyed on the night
  // object itself, which React Query hands back by the same reference until the payload changes.
  const sleep = glance?.sleep ?? null
  const segments = useMemo(() => hypnogramSegments(sleep), [sleep])

  if (isError) return <><Title /><ErrorState onRetry={() => void refetch()} error={error} /></>
  if (isPending || glance === undefined) return <><Title /><Loading /></>

  const { recovery, day } = glance

  // First run, or an archive with nothing in the last day and a half: three cards each saying it
  // has no reading would be the page repeating one fact three times, so it says it once.
  // emptyState.not_synced is not the words for this: that key means the person turned a data type
  // off, which is a different fact.
  const figures = [
    recovery.index, recovery.restingHeartRate, recovery.hrv, recovery.respiratoryRate, day.steps, day.activeMinutes,
  ]
  // A workout is something to show, so a day that holds only a run is not an empty page.
  if (sleep === null && day.heartRate.points.length === 0 && day.workouts.length === 0
    && figures.every((f) => f === null || f.value === null)) {
    return <><Title /><EmptyState title={t('glance.empty.title')} detail={t('glance.empty.detail')} /></>
  }

  // The latest instant anything on the page was read at: the heart rate trace samples most often,
  // and steps stand in on a day the watch sent steps but no heart rate.
  const asOfMs = day.heartRate.asOfMs ?? day.steps.asOfMs
  const span = asOfMs !== null
    ? t('glance.span', { time: formatTimeOfDay(asOfMs, language, timezone) })
    : t('glance.spanNoTime')

  // The night's own start in its own offset, the same label the night page and Sleep draw beside
  // the same hypnogram, so the bar and the time written next to it come from one instant.
  const bedMinutes = sleep === null
    ? null : inWindow(localMinutesOf(sleep.localDate, sleep.startMs, sleep.startOffsetMinutes), DEFAULT_WINDOW)
  const startLabel = bedMinutes !== null
    ? t('common.bedLabel', { time: formatClock(bedMinutes) })
    : t('common.bedTimeNotRecorded')

  const recoverySubtitle = recovery.index.asOfDate === glance.today
    ? t('glance.subtitle.today')
    : recovery.index.asOfDate !== null && recovery.index.asOfDate === yesterdayOf(glance.today)
      ? t('glance.subtitle.yesterday')
      : null
  // The breathing rate is in the payload only on a day it sits above its usual, as a warning. Why
  // an unscored index has no number is the card's empty line (below), not a note, so it is said once.
  const respiratory = recovery.respiratoryRate
  const respiratoryValue = respiratory === null ? null : formatFigure(respiratory, language)
  const recoveryNote = respiratoryValue !== null
    ? t('glance.recovery.respiratory', { value: `${respiratoryValue} ${t('recovery.units.breathsPerMinuteShort')}` })
    : null

  return (
    <>
      <Title />
      <p className="all-time-span">{span}</p>
      <CardGrid>
        <GlanceCard
          title={t('glance.sleep.title')}
          subtitle={sleep === null ? null : nightSpan(sleep, language, timezone)}
          headline={sleep === null ? null : { label: t('glance.sleep.asleep'), figure: sleep.asleep }}
          emptyLine={t('glance.sleep.empty')}
          secondary={sleep === null ? [] : [
            { label: t('glance.sleep.efficiency'), unit: t('charts.units.percent'), figure: sleep.efficiency },
            { label: t('glance.sleep.bed'), figure: sleep.bedtime },
            { label: t('glance.sleep.woke'), figure: sleep.waketime },
          ]}
          stripLabel={t('glance.sleep.strip')}
          stripCaption={t('glance.sleep.caption')}
          // Described for a screen reader only: the subtitle already names the night where a
          // sighted reader looks for it, and the same words twice would be noise.
          chart={sleep === null ? undefined : (
            <Described hidden text={t('sleep.sleepStages.basis', { date: sleep.localDate })}>
              <Hypnogram segments={segments} startLabel={startLabel} startClock={bedMinutes} totals={false}
                label={t('sleep.sleepStages.chartLabel', { date: sleep.localDate })} />
            </Described>
          )}
          link={sleep === null
            ? { to: '/sleep', text: t('glance.sleep.viewSleep') }
            : { to: `/sleep/night/${sleep.localDate}`, text: t('glance.sleep.link') }}
          // The subtitle is the night's own dates, so the headline's "night of ..." would repeat it.
          today={glance.today} timezone={timezone} night dayInSubtitle
        />
        <GlanceCard
          title={t('glance.recovery.title')}
          subtitle={recoverySubtitle}
          // The index carries no baseline of its own (it is already a comparison with the person's
          // usual), so its band is the line under it, in the words Recovery's index card uses.
          // An unscored index is no headline at all: the card prints its empty line, the one
          // sentence saying why, where a "No reading yet" headline and a note beneath it said the
          // same thing twice. The resting heart rate and HRV pairs still draw below it.
          headline={recovery.index.value === null ? null : {
            label: t('glance.recovery.index'), figure: recovery.index,
            usual: recovery.band === null ? undefined : t(`recoveryIndex.band.${recovery.band}`),
          }}
          emptyLine={t('glance.recovery.unscored')}
          dayInSubtitle={recoverySubtitle !== null}
          secondary={[
            { label: t('glance.recovery.rhr'), unit: t('charts.units.bpm'), figure: recovery.restingHeartRate },
            { label: t('glance.recovery.hrv'), unit: t('charts.units.milliseconds'), figure: recovery.hrv },
          ]}
          stripLabel={t('glance.recovery.strip')}
          stripCaption={t('glance.recovery.caption')}
          note={recoveryNote}
          link={{ to: '/recovery', text: t('glance.recovery.link') }}
          today={glance.today} timezone={timezone}
        />
        <GlanceCard
          title={t('glance.today.title')}
          subtitle={t('glance.today.subtitle')}
          headline={{ label: t('glance.today.steps'), figure: day.steps }}
          emptyLine={t('glance.noReading')}
          secondary={[
            { label: t('glance.today.activeMinutes'), unit: t('activity.units.min'), figure: day.activeMinutes },
          ]}
          stripLabel={t('glance.today.strip')}
          stripCaption={t('glance.today.caption')}
          // No trace at all rather than an empty chart before the watch has sent a reading today.
          // reduction is null because the glance does not say whether its 288 points were thinned,
          // and the chart never reads it (IntradayHeartRate's own comment on the prop).
          // Its description is the trace's own as-of time, printed under it the way each figure
          // prints its own.
          chart={day.heartRate.points.length > 0 ? (
            <div>
              <span className="label">{t('glance.today.heartRate')}</span>
              <Described text={day.heartRate.asOfMs !== null
                ? t('glance.asOf.time', { time: formatTimeOfDay(day.heartRate.asOfMs, language, timezone) })
                : t('glance.asOf.today')}>
                <IntradayHeartRate points={day.heartRate.points} reduction={null} label={t('glance.today.heartRateChart')} />
              </Described>
            </div>
          ) : undefined}
          chartStaleSources={day.heartRate.staleSources}
          extra={<TodayWorkouts workouts={day.workouts} />}
          link={{ to: '/activity', text: t('glance.today.link') }}
          today={glance.today} timezone={timezone}
        />
      </CardGrid>
    </>
  )
}
