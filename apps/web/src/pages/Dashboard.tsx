import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { july } from '../fixtures/july.js'
import { formatClock, formatDuration, trend } from '../format.js'

const worn = july.days.filter((d) => d.worn)
const unworn = july.days.length - worn.length
const totalSteps = worn.reduce((sum, d) => sum + (d.steps ?? 0), 0)
const dates = july.days.map((d) => d.date)

function numbers(pick: (d: (typeof worn)[number]) => number | null): number[] {
  return worn.map(pick).filter((v): v is number => v !== null)
}

const meanHrMin = numbers((d) => d.hrMin)
const meanHrMean = numbers((d) => d.hrMean)
const meanSleep = numbers((d) => d.sleepMinutes)
const avg = (xs: number[]) => xs.reduce((sum, v) => sum + v, 0) / xs.length
const maxSteps = Math.max(0, ...numbers((d) => d.steps))

const lastNight = july.schedule.at(-1)
const lastDate = july.days.at(-1)?.date ?? ''

// Verified, not assumed: this is the only metric that naturally hits zero in the fixture, so this branch is real.
const zeroSleepNights = worn.filter((d) => d.sleepMinutes === 0)

export function Dashboard() {
  const { t } = useTranslation()
  const period = t('common.periodLabel')
  const startLabel = lastNight?.bed != null
    ? t('common.bedLabel', { time: formatClock(lastNight.bed) })
    : t('common.bedTimeNotRecorded')

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      <ControlRow range="month" label={period} sources="2/2" syncedMinutesAgo={4} />
      <div className="grid">
        <Card span={3}>
          <StatTile label={t('dashboard.steps.label')} value={totalSteps.toLocaleString('en-GB')}
            basis={t('dashboard.steps.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(numbers((d) => d.steps), 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.steps)} labels={dates}
              label={t('dashboard.steps.chartLabel', { period })} unit={t('dashboard.units.steps')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.restingHr.label')} value={String(Math.round(avg(meanHrMin)))} unit="bpm"
            basis={t('dashboard.restingHr.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(meanHrMin, 'lower-is-better')}>
            <Sparkline values={july.days.map((d) => d.hrMin)} labels={dates}
              label={t('dashboard.restingHr.chartLabel', { period })} unit={t('dashboard.units.beatsPerMinute')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.sleep.label')} value={formatDuration(avg(meanSleep))}
            basis={t('dashboard.sleep.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(meanSleep, 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.sleepMinutes)} labels={dates}
              label={t('dashboard.sleep.chartLabel', { period })} unit={t('dashboard.units.minutesAsleep')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.meanHr.label')} value={String(Math.round(avg(meanHrMean)))} unit="bpm"
            basis={t('dashboard.meanHr.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(meanHrMean, 'neutral')}>
            <Sparkline values={july.days.map((d) => d.hrMean)} labels={dates}
              label={t('dashboard.meanHr.chartLabel', { period })} unit={t('dashboard.units.beatsPerMinute')} />
          </StatTile>
        </Card>

        <Card span={8} label={t('dashboard.heartRateRange.label')}
          basis={t('dashboard.heartRateRange.basis')}>
          <HeartRateRange days={july.days} baseline={july.baselines.hrMean}
            annotations={july.events.map((e) => ({ date: e.date, text: e.text }))} excluded={july.excluded}
            label={t('dashboard.heartRateRange.chartLabel', { period })} />
        </Card>
        <Card span={4} label={t('dashboard.flaggedDays.label')}
          basis={t('dashboard.flaggedDays.basis', { count: july.events.length, total: july.days.length })}>
          <ul style={{ margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {july.events.map((e) => (
              <li key={e.date} style={{ fontSize: 'var(--font-size-sm)' }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  {e.date.slice(8)} {t('common.julyAbbrev')}
                  {e.endDate ? ` ${t('common.to')} ${e.endDate.slice(8)} ${t('common.julyAbbrev')}` : ''}
                </div>
                <div style={{ color: 'var(--text-muted)' }}>{e.text}</div>
              </li>
            ))}
          </ul>
        </Card>

        <Card span={7} label={t('dashboard.sleepStages.label')} basis={t('dashboard.sleepStages.basis', { date: lastDate })}>
          <Hypnogram segments={july.hypnogram} startLabel={startLabel}
            label={t('dashboard.sleepStages.chartLabel', { date: lastDate })} />
        </Card>
        <Card span={5} label={t('dashboard.sleepSchedule.label')}
          basis={t('common.bedWakeBasis', { nights: july.schedule.length })}>
          <SleepSchedule nights={july.schedule} label={t('common.bedWakeChartLabel', { period })} />
        </Card>

        <Card span={8} label={t('dashboard.dailySteps.label')}
          basis={t('dashboard.dailySteps.basis', {
            worn: worn.length, total: july.days.length, maxSteps: maxSteps.toLocaleString('en-GB'),
          })}>
          <ActivityHeatmap days={july.days} max={maxSteps} label={t('dashboard.dailySteps.chartLabel', { period })} />
        </Card>
        <Card span={4} label={t('dashboard.recovery.label')}>
          <EmptyState title={t('dashboard.recovery.emptyTitle')}
            detail={t('dashboard.recovery.emptyDetail')} />
        </Card>

        <Card span={12} label={t('dashboard.anomalies.label')}>
          {zeroSleepNights.length === 0 ? (
            <EmptyState title={t('dashboard.anomalies.emptyTitle')}
              detail={t('dashboard.anomalies.emptyDetail', { worn: worn.length, total: july.days.length, unworn })} />
          ) : (
            <p className="basis">
              {t('dashboard.anomalies.summary', {
                count: zeroSleepNights.length, worn: worn.length,
                dates: zeroSleepNights.map((d) => d.date).join(', '),
              })}
            </p>
          )}
        </Card>
      </div>
    </>
  )
}
