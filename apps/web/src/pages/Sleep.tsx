import { chartVar, type ChartToken } from '@haelan/tokens'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { july } from '../fixtures/july.js'
import type { Stage } from '../fixtures/july.js'
import { formatClock, formatDuration, toneFor } from '../format.js'
import type { Delta, Translate } from '../format.js'

const STAGE_ORDER: Stage[] = ['deep', 'light', 'rem', 'awake']
const STAGE_LABEL_KEY: Record<Stage, string> = {
  deep: 'sleep.stage.deep', light: 'sleep.stage.light', rem: 'sleep.stage.rem', awake: 'sleep.stage.awake',
}
// Token names, not literal strings: a rename in chart.ts becomes a compile error, and the swatch follows theme switches via CSS inheritance.
const STAGE_TOKEN: Record<Stage, ChartToken> = {
  deep: 'stage-deep', light: 'stage-light', rem: 'stage-rem', awake: 'stage-awake',
}

const stageTotals = july.hypnogram.reduce<Record<Stage, number>>(
  (acc, seg) => ({ ...acc, [seg.stage]: (acc[seg.stage] ?? 0) + (seg.to - seg.from) }),
  { deep: 0, light: 0, rem: 0, awake: 0 },
)

const lastDay = july.days.at(-1)
const lastNight = july.schedule.at(-1)
const baseline = july.baselines.sleepMinutes

// Sleep duration's polarity is unambiguous: more, up to the baseline band, is always the good direction.
function baselineDelta(t: Translate, minutes: number, low: number, high: number): Delta {
  const range = t('sleep.baselineRange', { low: formatDuration(low), high: formatDuration(high) })
  const basis = t('sleep.baselineBasis', { low: formatDuration(low), high: formatDuration(high) })
  if (minutes < low) return { text: t('sleep.belowBaseline', { range }), dir: 'down', tone: toneFor('down', 'higher-is-better'), basis }
  if (minutes > high) return { text: t('sleep.aboveBaseline', { range }), dir: 'up', tone: toneFor('up', 'higher-is-better'), basis }
  return { text: t('sleep.withinBaseline', { range }), dir: 'flat', tone: toneFor('flat', 'higher-is-better'), basis }
}

export function Sleep() {
  const { t } = useTranslation()
  const period = t('common.periodLabel')

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('sleep.title')}</h1>
      <ControlRow range="day" label={lastDay?.date ?? ''} sources="2/2" syncedMinutesAgo={12} />
      <div className="grid">
        <Card span={4}>
          {lastDay?.sleepMinutes != null ? (
            <StatTile label={t('sleep.lastNight.label')} value={formatDuration(lastDay.sleepMinutes)}
              basis={t('sleep.lastNight.basis', { date: lastDay.date })}
              delta={baselineDelta(t, lastDay.sleepMinutes, baseline.low, baseline.high)} />
          ) : (
            <>
              <span className="label">{t('sleep.lastNight.label')}</span>
              <EmptyState title={t('sleep.lastNight.emptyTitle')}
                detail={lastDay?.worn ? t('common.deviceWornGap') : t('common.deviceNotWorn')} />
            </>
          )}
        </Card>

        <Card span={8} label={t('sleep.stages.label')} basis={t('sleep.stages.basis', { date: lastDay?.date ?? t('sleep.noDate') })}>
          <Hypnogram segments={july.hypnogram}
            startLabel={lastNight?.bed != null ? t('common.bedLabel', { time: formatClock(lastNight.bed) }) : t('common.bedTimeNotRecorded')}
            label={t('sleep.stages.chartLabel', { date: lastDay?.date ?? t('sleep.lastRecordedNightFallback') })} />
          <ul style={{ display: 'flex', gap: 'var(--space-4)', margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none' }}>
            {STAGE_ORDER.map((stage) => (
              <li key={stage} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: `var(${chartVar(STAGE_TOKEN[stage])})`, display: 'inline-block' }} />
                {t(STAGE_LABEL_KEY[stage])} {formatDuration(stageTotals[stage])}
              </li>
            ))}
          </ul>
        </Card>

        <Card span={12} label={t('sleep.nap.label')}>
          {lastNight && lastNight.naps.length > 0 ? (
            <p className="basis">
              {t('sleep.nap.summary', {
                count: lastNight.naps.length,
                times: lastNight.naps.map((n) => formatClock(n)).join(', '),
                date: lastDay?.date,
              })}
            </p>
          ) : (
            <EmptyState title={t('sleep.nap.emptyTitle')}
              detail={lastDay?.worn
                ? t('sleep.nap.wornAbsence', { date: lastDay.date })
                : t('sleep.nap.notWornEither')} />
          )}
        </Card>

        <Card span={12} label={t('sleep.schedule.label')}
          basis={t('common.bedWakeBasis', { nights: july.schedule.length })}>
          <SleepSchedule nights={july.schedule} label={t('common.bedWakeChartLabel', { period })} />
        </Card>
      </div>
    </>
  )
}
