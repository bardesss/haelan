import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { IntradayHeartRate } from '../../charts/IntradayHeartRate.js'
import { Sparkline } from '../../charts/Sparkline.js'
import type { GlanceDay } from '../../data/useGlance.js'
import { DashCard, Described } from './cardShared.js'
import { formatFigure, formatTimeOfDay, paceKey, usualLine } from './glanceText.js'
import { TodayWorkouts } from './TodayWorkouts.js'

/**
 * Today's steps, active minutes and pace against the usual, the seven-day steps strip with the
 * usual shaded behind it, the intraday heart rate trace and today's workouts.
 *
 * The pace line takes over from the plain so-far line the moment the server has a verdict: it
 * names which way today is running (ahead, on, behind) as of the last reading it compared, and
 * says what the usual pace was by that same time - so a reader never has to work out for
 * themselves whether "5,900 so far" is good or bad partway through the day. Without a verdict
 * (`stepsPace` null, or thin) the so-far line speaks instead, the same wording every other partial
 * figure in the redesign uses.
 */
export function TodayCard({ day, span, timezone }: { day: GlanceDay, span: 8 | 12, timezone: string }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { values, labels } = useMemo(() => ({
    values: day.steps.strip.map((d) => d.value), labels: day.steps.strip.map((d) => d.localDate),
  }), [day.steps.strip])
  const band = day.steps.baseline !== null && !day.steps.baseline.thin ? day.steps.baseline : undefined
  // Same device as NightCard's own bandLabels: memoised on band/language so a fresh object identity
  // every render does not fold into Sparkline's `build` dependency array and rebuild the chart for
  // no reason that has anything to do with what it draws.
  const bandLabels = useMemo(() => band === undefined ? undefined : {
    low: formatFigure({ ...day.steps, value: band.low }, language) ?? '',
    high: formatFigure({ ...day.steps, value: band.high }, language) ?? '',
  }, [band, language])
  const pace = day.stepsPace
  const key = paceKey(pace)
  const isAhead = pace?.standing === 'ahead'
  return (
    <DashCard span={span} title={t('glance.today.title')} subtitle={t('glance.today.subtitle')}
      link={{ to: '/activity', text: t('glance.today.link') }}
      staleFigures={[day.steps, day.activeMinutes]} staleExtra={day.heartRate.staleSources}>
      <div className="dash-lead">
        <div>
          <span className="label">{t('glance.today.steps')}</span>
          <div className="dash-headline-sm">{formatFigure(day.steps, language) ?? t('glance.noReading')}</div>
          <span className="label">{t('glance.today.activeMinutes')}</span>
          <div className="dash-headline-sm">
            {formatFigure(day.activeMinutes, language) ?? t('glance.noReading')}{' '}
            <span className="glance-unit">{t('activity.units.min')}</span>
          </div>
          {key !== null && pace !== null ? (
            <p className={isAhead ? 'dash-pace is-ahead' : 'dash-pace'}>
              <span className="dash-pace-word">{t(key)}</span>{' '}
              · {t('glance.pace.usualBy', {
                time: formatTimeOfDay(pace.atMs, language, timezone),
                value: formatFigure({ ...day.steps, value: pace.center }, language),
              })}
            </p>
          ) : (
            <p className="dash-pace">{usualLine(day.steps, t, language)}</p>
          )}
        </div>
        {values.filter((v) => v !== null).length > 1 && (
          <div className="dash-lead-strip">
            <Described text={usualLine(day.steps, t, language) ?? t('glance.today.caption')} hidden>
              <Sparkline values={values} labels={labels} label={t('glance.today.strip')} unit={t('glance.today.steps')}
                metric={day.steps.metric} baseline={band} bandLabels={bandLabels} height={64}
                formatValue={(v, absent) => (v === null ? absent : formatFigure({ ...day.steps, value: v }, language) ?? absent)} />
            </Described>
            <p className="dash-caption">{t('glance.today.caption')}</p>
          </div>
        )}
      </div>
      {day.heartRate.points.length > 0 && (
        <div>
          <span className="label">{t('glance.today.heartRate')}</span>
          <Described text={day.heartRate.asOfMs !== null
            ? t('glance.asOf.time', { time: formatTimeOfDay(day.heartRate.asOfMs, language, timezone) })
            : t('glance.asOf.today')}>
            <IntradayHeartRate points={day.heartRate.points} reduction={null} label={t('glance.today.heartRateChart')} />
          </Described>
        </div>
      )}
      <TodayWorkouts workouts={day.workouts} />
    </DashCard>
  )
}
