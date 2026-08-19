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

function numbers(pick: (d: (typeof worn)[number]) => number | null): number[] {
  return worn.map(pick).filter((v): v is number => v !== null)
}

const meanHrMin = numbers((d) => d.hrMin)
const meanHrMean = numbers((d) => d.hrMean)
const meanSleep = numbers((d) => d.sleepMinutes)
const avg = (xs: number[]) => xs.reduce((sum, v) => sum + v, 0) / xs.length

const lastNight = july.schedule.at(-1)
const startLabel = lastNight?.bed != null ? `Bed ${formatClock(lastNight.bed)}` : 'Bed time not recorded'
const lastDate = july.days.at(-1)?.date ?? ''

// Verified rather than assumed: some nights this month have naps, so a
// month-wide "no naps" empty state would misreport real data. There is no
// naturally zero event count in this fixture at the monthly grain, so the
// two required empty states below use metrics that are genuinely absent,
// and the "verified zero" one below actually checks rather than asserting.
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
            <Sparkline values={july.days.map((d) => d.steps)} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Resting heart rate" value={String(Math.round(avg(meanHrMin)))} unit="bpm"
            basis={`mean, ${worn.length} of ${july.days.length} days, ${unworn} days not worn`}
            delta={trend(meanHrMin, 'lower-is-better')}>
            <Sparkline values={july.days.map((d) => d.hrMin)} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Sleep" value={formatDuration(avg(meanSleep))}
            basis={`mean, ${worn.length} of ${july.days.length} nights, ${unworn} nights not worn`}
            delta={trend(meanSleep, 'higher-is-better')}>
            <Sparkline values={july.days.map((d) => d.sleepMinutes)} />
          </StatTile>
        </Card>
        <Card span={3}>
          <StatTile label="Heart rate" value={String(Math.round(avg(meanHrMean)))} unit="bpm"
            basis={`mean, ${worn.length} of ${july.days.length} days, ${unworn} days not worn`}
            delta={trend(meanHrMean, 'neutral')}>
            <Sparkline values={july.days.map((d) => d.hrMean)} />
          </StatTile>
        </Card>

        <Card span={8}>
          <span className="label">Heart rate</span>
          <p className="basis">daily minimum, mean and maximum, shaded band is the 60 day baseline</p>
          <HeartRateRange days={july.days} baseline={july.baselines.hrMean}
            annotations={july.events.map((e) => ({ date: e.date, text: e.text }))} excluded={july.excluded} />
        </Card>
        <Card span={4}>
          <span className="label">Recovery notes</span>
          <p className="basis">{july.events.length} of {july.days.length} days flagged, annotated on the heart rate chart</p>
          <ul style={{ margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {july.events.map((e) => (
              <li key={e.date} style={{ fontSize: 'var(--font-size-sm)' }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  {e.date.slice(8)} Jul{e.endDate ? `–${e.endDate.slice(8)} Jul` : ''}
                </div>
                <div style={{ color: 'var(--text-muted)' }}>{e.text}</div>
              </li>
            ))}
          </ul>
        </Card>

        <Card span={7}>
          <span className="label">Sleep stages</span>
          <p className="basis">last night, {lastDate}</p>
          <Hypnogram segments={july.hypnogram} startLabel={startLabel} />
        </Card>
        <Card span={5}>
          <span className="label">Sleep schedule</span>
          <p className="basis">bed and wake time, {july.schedule.length} nights, dot marks a nap</p>
          <SleepSchedule nights={july.schedule} />
        </Card>

        <Card span={8}>
          <span className="label">Daily steps</span>
          <p className="basis">calendar heatmap, {worn.length} of {july.days.length} days worn, darker is more steps</p>
          <ActivityHeatmap days={july.days} />
        </Card>
        <Card span={4}>
          <span className="label">Recovery</span>
          <EmptyState title="No source is providing this data."
            detail="Connect a device that reports heart rate variability to see recovery scores here." />
        </Card>

        <Card span={12}>
          <span className="label">Sleep anomalies</span>
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
