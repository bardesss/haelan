import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { IntradayHeartRate } from '../../charts/IntradayHeartRate.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { GlanceDay } from '../../data/useGlance.js'
import { DashCard, Described } from './cardShared.js'
import { dayStanding, formatFigure, formatLongDate, formatTimeOfDay, localMidnightMs, nextDayOf, paceKey, usualLine } from './glanceText.js'
import { TodayWorkouts } from './TodayWorkouts.js'

/**
 * Today as the approved T2 mockup draws it: steps and active minutes side by side, the pace line
 * under them, the seven-day steps strip across the card with the usual shaded behind it and a dot
 * per day, then the heart rate trace in its compact form from local midnight to the last reading,
 * with today's workouts shaded on it, and the workouts themselves.
 *
 * The pace line takes over from the plain so-far line the moment the server has a verdict: it
 * names which way today is running (ahead, on, behind) as of the last reading it compared, and
 * says what the usual pace was by that same time - so a reader never has to work out for
 * themselves whether "5,900 so far" is good or bad partway through the day. Without a verdict
 * (`stepsPace` null, or thin) the so-far line speaks instead, the same wording every other partial
 * figure in the redesign uses.
 *
 * A finished day (M9c, `finished`) is the same card for a day already over: titled "That day" with
 * its date beside it, the whole day's verdict against the usual whole day in place of a pace ("Above
 * your usual day · usual 6,800 – 10,400"), and the heart rate trace across the whole day, 00:00 to
 * the next midnight, rather than to its last reading.
 */
export function TodayCard({ day, span, today, timezone, finished = false }: {
  day: GlanceDay, span: 8 | 12, today: string, timezone: string, finished?: boolean
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { values, labels, standings } = useMemo(() => ({
    values: day.steps.strip.map((d) => d.value), labels: day.steps.strip.map((d) => d.localDate),
    standings: day.steps.strip.map((d) => d.standing),
  }), [day.steps.strip])
  const band = day.steps.baseline !== null && !day.steps.baseline.thin ? day.steps.baseline : undefined
  // Same device as NightCard's own bandLabels: memoised on band/language so a fresh object identity
  // every render does not fold into Sparkline's `build` dependency array and rebuild the chart for
  // no reason that has anything to do with what it draws.
  const bandLabels = useMemo(() => band === undefined ? undefined : {
    low: formatFigure({ ...day.steps, value: band.low }, language) ?? '',
    high: formatFigure({ ...day.steps, value: band.high }, language) ?? '',
  }, [band, language])
  // Memoised for the same reason: both reach IntradayHeartRate's own `build` dependencies.
  const midnight = useMemo(() => localMidnightMs(today, timezone), [today, timezone])
  const endMs = useMemo(() => finished ? localMidnightMs(nextDayOf(today), timezone) : undefined, [finished, today, timezone])
  const workoutSpans = useMemo(() => day.workouts.map((w) => ({ startMs: w.startMs, endMs: w.endMs })), [day.workouts])
  // Never a pace on a finished day, whatever the payload carries: a day that is over has no "so
  // far" to be ahead or behind in.
  const pace = finished ? null : day.stepsPace
  const key = paceKey(pace)
  const verdict = finished ? dayStanding(day.steps, t, language) : null
  // Above the usual day reads in the pace line's own ahead colour; below stays plain text, as
  // behind does.
  const isAbove = verdict?.standing === 'above'
  const isAhead = pace?.standing === 'ahead'
  // Task 19a's own note: `standing` can be null while the band is present (no verdict before 5% of
  // the usual day), so `key === null` is not "no pace object" - it is "no verdict to word". Either
  // way the so-far line is what falls back, and only when that itself has something to say: a day
  // with no baseline at all would otherwise print an empty `<p class="dash-pace">`, which is worse
  // for a screen reader than no paragraph at all.
  const usual = usualLine(day.steps, t, language)
  return (
    <DashCard span={span} title={t(finished ? 'glance.today.thatDay' : 'glance.today.title')}
      subtitle={finished ? formatLongDate(today, language) : t('glance.today.subtitle')}
      link={{ to: '/activity', text: t('glance.today.link') }}>
      <div>
        <div className="dash-today-figures">
          <div>
            <span className="label">{t('glance.today.steps')}</span>
            <div className="dash-headline-sm">{formatFigure(day.steps, language) ?? t('glance.noReading')}</div>
          </div>
          <div>
            <span className="label">{t('glance.today.activeMinutes')}</span>
            <div className="dash-headline-sm">
              {formatFigure(day.activeMinutes, language) ?? t('glance.noReading')}{' '}
              <span className="glance-unit">{t('activity.units.min')}</span>
            </div>
          </div>
        </div>
        {verdict !== null ? (
          <p className={isAbove ? 'dash-pace is-ahead' : 'dash-pace'}>
            <span className="dash-pace-word">{verdict.word}</span>{' '}
            · {verdict.range}
          </p>
        ) : key !== null && pace !== null ? (
          <p className={isAhead ? 'dash-pace is-ahead' : 'dash-pace'}>
            <span className="dash-pace-word">{t(key)}</span>{' '}
            · {t('glance.pace.usualBy', {
              time: formatTimeOfDay(pace.atMs, language, timezone),
              value: formatFigure({ ...day.steps, value: pace.center }, language),
            })}
          </p>
        ) : usual !== null ? (
          <p className="dash-pace">{usual}</p>
        ) : null}
      </div>
      {values.filter((v) => v !== null).length > 1 && (
        <div>
          <Described text={usualLine(day.steps, t, language) ?? t('glance.today.caption')} hidden>
            <Sparkline values={values} labels={labels} label={t('glance.today.strip')} unit={t('glance.today.steps')}
              metric={day.steps.metric} baseline={band} bandLabels={bandLabels} height={64}
              dots pointStandings={standings} tableToggle={false}
              formatValue={(v, absent) => (v === null ? absent : formatFigure({ ...day.steps, value: v }, language) ?? absent)} />
          </Described>
          <p className="dash-caption">{t('glance.today.caption')}</p>
        </div>
      )}
      {day.heartRate.points.length > 0 && (
        <div>
          <span className="label">{t(finished ? 'glance.today.heartRateWholeDay' : 'glance.today.heartRateSinceMidnight')}</span>
          <Described hidden text={finished ? t('glance.asOf.thatDay')
            : day.heartRate.asOfMs !== null
              ? t('glance.asOf.time', { time: formatTimeOfDay(day.heartRate.asOfMs, language, timezone) })
              : t('glance.asOf.today')}>
            <IntradayHeartRate points={day.heartRate.points} reduction={null}
              label={t(finished ? 'glance.today.heartRateChartThatDay' : 'glance.today.heartRateChart')}
              compact startMs={midnight} endMs={endMs} spans={workoutSpans} />
          </Described>
        </div>
      )}
      <TodayWorkouts workouts={day.workouts} finished={finished} />
    </DashCard>
  )
}
