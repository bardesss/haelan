import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { SleepSchedule } from '../../../charts/SleepSchedule.js'
import { localMinutesOf, napInWindow, placedUsualBand, withinSchedule, WIDE_WINDOW } from '../../../charts/schedule.js'
import { useNights } from '../../../data/useNights.js'
import { oneNightPerDate } from '../../../data/nights.js'
import type { PeriodFigure, PeriodRange, ScheduleSides, SleepPeriodData } from '../../../data/periodTypes.js'
import type { Translate } from '../../../format.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { latestBand } from '../../detail/periodText.js'
import { useSleepLabel } from './labels.js'

const NBSP = ' '
const EMPTY_NAPS: number[] = Object.freeze([]) as never[]

/** Whether the period has a schedule to show: a bedtime or a wake time on some night. */
export function hasSchedule(schedule: SleepPeriodData['schedule']): boolean {
  return schedule.bedtime !== null || schedule.waketime !== null
}

/** Whether the range draws each night on the schedule chart (week and month) rather than weekly rows. */
export function drawsNights(range: PeriodRange): boolean {
  return range === 'week' || range === 'month'
}

// A difference in clock minutes, taken the short way round midnight: -720 up to 720.
const clockDifference = (a: number, b: number): number => ((((a - b) % 1440) + 1440 + 720) % 1440) - 720

// "45 min later" / "45 min eerder", or "at the same time", for one side of the weekend sentence.
function shift(minutes: number, t: Translate): string {
  const rounded = Math.round(minutes)
  if (rounded === 0) return t('sleep.period.shift.same')
  const value = `${Math.abs(rounded)}${NBSP}${t('activity.units.min')}`
  return t(rounded > 0 ? 'sleep.period.shift.later' : 'sleep.period.shift.earlier', { value })
}

/** "At the weekend 45 min later to bed and 70 min later up"; null when either side is missing. */
export function sidesSentence(sides: ScheduleSides, t: Translate): string | null {
  const { weekday, weekend } = sides
  if (weekday === null || weekend === null) return null
  return t('sleep.period.sides', {
    bed: shift(clockDifference(weekend.bedtimeMinutes, weekday.bedtimeMinutes), t),
    wake: shift(clockDifference(weekend.waketimeMinutes, weekday.waketimeMinutes), t),
  })
}

/**
 * "Slaapschema": on Week and Month every night's bed to wake on the schedule chart, against the
 * usual bed and wake bands, with the naps /sleep/nights knows the times of; on 3 months and Year the
 * bedtime and wake time rows over their weekly points instead, since a year of nights is no chart
 * to read. Under either, the bedtime variability against its usual, and the weekend against the
 * weekdays in one sentence.
 *
 * Bed and wake are the period read's own (each night's sleep_bedtime_minutes and
 * sleep_waketime_minutes, the same pair the old page read from /series); /sleep/nights adds only
 * the naps, which no metric has a time of day for, and is asked only on the ranges that draw them.
 * The naps column follows that request (showNaps), so a column of "none" never claims a check that
 * was not made.
 */
export function SleepScheduleCard({ data, range, span, nightsRange }: {
  data: SleepPeriodData
  range: PeriodRange
  span: number
  nightsRange: { from: string, to: string, source: string }
}) {
  const { t } = useTranslation()
  const labelOf = useSleepLabel()
  const captionId = useId()
  const short = drawsNights(range)
  const nightsQuery = useNights(nightsRange, { enabled: short })
  const { schedule } = data

  const napsByDate = useMemo(() => {
    const out = new Map<string, number[]>()
    for (const night of oneNightPerDate(nightsQuery.data?.items ?? [])) {
      // The wake end's offset: a nap falls on the date itself, the same side of midnight as the wake.
      out.set(night.localDate, night.naps.map((ms) => localMinutesOf(night.localDate, ms, night.endOffsetMinutes)))
    }
    return out
  }, [nightsQuery.data])

  // Oldest first, as the chart reads down its rows; the list sends the newest first.
  const nights = useMemo(() => [...data.nights].reverse().map((night) => {
    // Signed minutes from the wake day's midnight, as stored: 23:04 is -56, and a day sleeper's
    // 13:00 is 780. withinSchedule places the pair; nothing is folded into a range here.
    const bedRaw = night.bedtimeMinutes
    const wakeRaw = night.waketimeMinutes
    const naps = napsByDate.get(night.localDate)
    return {
      date: night.localDate,
      ...withinSchedule(bedRaw, wakeRaw, WIDE_WINDOW),
      naps: naps === undefined ? EMPTY_NAPS : naps.map((raw) => napInWindow(raw, bedRaw ?? wakeRaw, WIDE_WINDOW)),
    }
  }), [data.nights, napsByDate])

  const bedBand = latestBand(schedule.bedtime?.daily)
  const wakeBand = latestBand(schedule.waketime?.daily)
  const usualBands = useMemo(() => {
    return [placedUsualBand(bedBand, bedBand?.low ?? null), placedUsualBand(wakeBand, bedBand?.center ?? null)]
      .filter((band): band is { low: number, high: number } => band !== null)
  }, [bedBand, wakeBand])

  const rows = useMemo(() => [...(short ? [] : [schedule.bedtime, schedule.waketime]), schedule.variability]
    .filter((figure): figure is PeriodFigure => figure !== null), [short, schedule])
  const sides = sidesSentence(schedule.sides, t)
  const label = t('sleep.night.week.schedule')

  return (
    <Card span={span} label={label}>
      {short && (
        <>
          <BasisContext.Provider value={captionId}>
            <SleepSchedule nights={nights} showNaps={nightsQuery.isSuccess} label={label} usualBands={usualBands} />
          </BasisContext.Provider>
          <p id={captionId} className="dash-caption">{t(usualBands.length > 0 ? 'sleep.period.scheduleCaptionBand' : 'sleep.period.scheduleCaption')}</p>
        </>
      )}
      {/* Two across at most in a half card, as the mornings: three came out narrower than their labels. */}
      <PeriodFigureRows figures={rows} labelOf={labelOf} noun="night" max={span === 6 ? 2 : undefined} />
      {sides !== null && <p className="detail-verdict">{sides}</p>}
    </Card>
  )
}
