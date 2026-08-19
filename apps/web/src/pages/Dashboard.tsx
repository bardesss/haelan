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
const startLabel = lastNight?.bed != null ? `Bed ${formatClock(lastNight.bed)}` : 'Bed time not recorded'
const lastDate = july.days.at(-1)?.date ?? ''

// Verified, not assumed: this is the only metric that naturally hits zero in the fixture, so this branch is real.
const zeroSleepNights = worn.filter((d) => d.sleepMinutes === 0)

export function Dashboard() {
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>Dashboard</h1>
      <ControlRow range="Month" label="July 2026" sources="2/2" syncedAgo="4 min ago" />
      <div className="grid">
        <Card span={3}>
          <StatTile label="Steps" value={totalSteps.toLocaleString('en-GB')}
            basis={`sum, ${worn.length} of ${july.days.length} days, ${unworn} days not worn`}
            delta={trend(numbers((d) => d.steps), 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.steps)} labels={dates}
              label="Daily steps through July 2026" unit="Steps" />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Resting heart rate" value={String(Math.round(avg(meanHrMin)))} unit="bpm"
            basis={`mean, ${worn.length} of ${july.days.length} days, ${unworn} days not worn`}
            delta={trend(meanHrMin, 'lower-is-better')}>
            <Sparkline values={july.days.map((d) => d.hrMin)} labels={dates}
              label="Daily resting heart rate through July 2026" unit="Beats per minute" />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Sleep" value={formatDuration(avg(meanSleep))}
            basis={`mean, ${worn.length} of ${july.days.length} nights, ${unworn} nights not worn`}
            delta={trend(meanSleep, 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.sleepMinutes)} labels={dates}
              label="Nightly sleep duration through July 2026" unit="Minutes asleep" />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Mean heart rate" value={String(Math.round(avg(meanHrMean)))} unit="bpm"
            basis={`mean, ${worn.length} of ${july.days.length} days, ${unworn} days not worn`}
            delta={trend(meanHrMean, 'neutral')}>
            <Sparkline values={july.days.map((d) => d.hrMean)} labels={dates}
              label="Daily mean heart rate through July 2026" unit="Beats per minute" />
          </StatTile>
        </Card>

        <Card span={8} label="Heart rate range"
          basis="daily minimum, mean and maximum, shaded band is the 60 day baseline">
          <HeartRateRange days={july.days} baseline={july.baselines.hrMean}
            annotations={july.events.map((e) => ({ date: e.date, text: e.text }))} excluded={july.excluded}
            label="Daily heart rate minimum, mean and maximum through July 2026" />
        </Card>
        <Card span={4} label="Flagged days"
          basis={`${july.events.length} of ${july.days.length} days flagged, annotated on the heart rate chart`}>
          <ul style={{ margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {july.events.map((e) => (
              <li key={e.date} style={{ fontSize: 'var(--font-size-sm)' }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  {e.date.slice(8)} Jul{e.endDate ? ` to ${e.endDate.slice(8)} Jul` : ''}
                </div>
                <div style={{ color: 'var(--text-muted)' }}>{e.text}</div>
              </li>
            ))}
          </ul>
        </Card>

        <Card span={7} label="Sleep stages" basis={`last night, ${lastDate}`}>
          <Hypnogram segments={july.hypnogram} startLabel={startLabel}
            label={`Sleep stages through the night of ${lastDate}`} />
        </Card>
        <Card span={5} label="Sleep schedule"
          basis={`bed and wake time, ${july.schedule.length} nights, dot marks a nap`}>
          <SleepSchedule nights={july.schedule} label="Bed and wake times for each night of July 2026" />
        </Card>

        <Card span={8} label="Daily steps"
          basis={`calendar heatmap, ${worn.length} of ${july.days.length} days worn, 0 to ${maxSteps.toLocaleString('en-GB')} steps, stronger colour is more steps, days with no reading carry an absence dot`}>
          <ActivityHeatmap days={july.days} max={maxSteps} label="Steps per day through July 2026" />
        </Card>
        <Card span={4} label="Recovery">
          <EmptyState title="No source is providing this data."
            detail="Connect a device that reports heart rate variability to see recovery scores here." />
        </Card>

        <Card span={12} label="Sleep anomalies">
          {zeroSleepNights.length === 0 ? (
            <EmptyState title="No nights with zero recorded sleep in July."
              detail={`Checked ${worn.length} of ${july.days.length} nights the device was worn. The remaining ${unworn} nights have no reading at all, which is a different kind of gap.`} />
          ) : (
            <p className="basis">
              {zeroSleepNights.length} of {worn.length} worn nights recorded zero minutes of sleep: {zeroSleepNights.map((d) => d.date).join(', ')}.
            </p>
          )}
        </Card>
      </div>
    </>
  )
}
