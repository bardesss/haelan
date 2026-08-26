import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import type { PageControlsState } from '../controls/usePageControls.js'
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
  const { t, i18n } = useTranslation()
  const period = t('common.periodLabel')
  // This page is still fixture data for a fixed July, not wired to usePageControls, so its row is
  // a static stand-in with no-op setters rather than the live hook: the hook reads the URL through
  // useSession, which needs a QueryClientProvider this page's own tests do not set up, and wiring
  // the two together for real is a later task. from and to both read as the fixture's own month
  // so the stepper label matches what it always said, rather than a literal placeholder.
  const controls: PageControlsState = {
    tab: 'month', anchor: '2026-07-31', source: 'merged',
    from: period, to: period,
    setTab: () => {}, setAnchor: () => {}, step: () => {}, setSource: () => {},
  }
  // The active language, not a pinned locale: a bilingual app whose numbers only ever group like
  // English is not actually speaking Dutch when it renders Dutch.
  const groupNumber = (value: number) => value.toLocaleString(i18n.language)
  const startLabel = lastNight?.bed != null
    ? t('common.bedLabel', { time: formatClock(lastNight.bed) })
    : t('common.bedTimeNotRecorded')

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      {/* The row beneath this one is still fixture data for July regardless of what range or
          source gets picked here; wiring the two together is a later task. Sources is empty
          rather than invented device names, since this page has no real source list yet. */}
      <ControlRow controls={controls} sources={[]} syncedMinutesAgo={4} />
      <div className="grid">
        <Card span={3}>
          <StatTile label={t('dashboard.steps.label')} value={groupNumber(totalSteps)}
            basis={t('dashboard.steps.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(t, numbers((d) => d.steps), 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.steps)} labels={dates}
              label={t('dashboard.steps.chartLabel', { period })} unit={t('dashboard.units.steps')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.restingHr.label')} value={String(Math.round(avg(meanHrMin)))} unit={t('dashboard.units.bpm')}
            basis={t('dashboard.restingHr.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(t, meanHrMin, 'lower-is-better')}>
            <Sparkline values={july.days.map((d) => d.hrMin)} labels={dates}
              label={t('dashboard.restingHr.chartLabel', { period })} unit={t('dashboard.units.beatsPerMinute')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.sleep.label')} value={formatDuration(avg(meanSleep))}
            basis={t('dashboard.sleep.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(t, meanSleep, 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.sleepMinutes)} labels={dates}
              label={t('dashboard.sleep.chartLabel', { period })} unit={t('dashboard.units.minutesAsleep')} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label={t('dashboard.meanHr.label')} value={String(Math.round(avg(meanHrMean)))} unit={t('dashboard.units.bpm')}
            basis={t('dashboard.meanHr.basis', { worn: worn.length, total: july.days.length, unworn })}
            delta={trend(t, meanHrMean, 'neutral')}>
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
            worn: worn.length, total: july.days.length, maxSteps: groupNumber(maxSteps),
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
