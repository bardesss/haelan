import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { july } from '../fixtures/july.js'
import type { Stage } from '../fixtures/july.js'
import { formatClock, formatDuration } from '../format.js'
import type { Delta } from '../format.js'

const STAGE_ORDER: Stage[] = ['deep', 'light', 'rem', 'awake']
const STAGE_LABEL: Record<Stage, string> = { deep: 'Deep', light: 'Light', rem: 'REM', awake: 'Awake' }
// Reference the token by name rather than resolving it in JS, so the swatch
// follows a theme switch through ordinary CSS custom-property inheritance
// instead of needing its own render-time read.
const STAGE_VAR: Record<Stage, string> = {
  deep: '--chart-stage-deep', light: '--chart-stage-light', rem: '--chart-stage-rem', awake: '--chart-stage-awake',
}

const stageTotals = july.hypnogram.reduce<Record<Stage, number>>(
  (acc, seg) => ({ ...acc, [seg.stage]: (acc[seg.stage] ?? 0) + (seg.to - seg.from) }),
  { deep: 0, light: 0, rem: 0, awake: 0 },
)

const lastDay = july.days.at(-1)
const lastNight = july.schedule.at(-1)
const baseline = july.baselines.sleepMinutes

function baselineDelta(minutes: number, low: number, high: number): Delta {
  if (minutes < low) return { text: `↓ below the ${formatDuration(low)}–${formatDuration(high)} baseline`, dir: 'down' }
  if (minutes > high) return { text: `↑ above the ${formatDuration(low)}–${formatDuration(high)} baseline`, dir: 'up' }
  return { text: `→ within the ${formatDuration(low)}–${formatDuration(high)} baseline`, dir: 'flat' }
}

export function Sleep() {
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>Sleep</h1>
      <ControlRow range="Day" label={lastDay?.date ?? ''} sources="2/2" syncedAgo="12 min ago" />
      <div className="grid">
        <Card span={4}>
          {lastDay?.sleepMinutes != null ? (
            <StatTile label="Last night" value={formatDuration(lastDay.sleepMinutes)}
              basis={`recorded, ${lastDay.date}`}
              delta={baselineDelta(lastDay.sleepMinutes, baseline.low, baseline.high)} />
          ) : (
            <>
              <span className="label">Last night</span>
              <EmptyState title="No sleep recorded for this night."
                detail={lastDay?.worn ? 'Device was worn, so this is a real gap in the reading.' : 'Device was not worn.'} />
            </>
          )}
        </Card>

        <Card span={8}>
          <span className="label">Sleep stages</span>
          <p className="basis">last night, {lastDay?.date ?? 'no date'}, per minute</p>
          <Hypnogram segments={july.hypnogram}
            startLabel={lastNight?.bed != null ? `Bed ${formatClock(lastNight.bed)}` : 'Bed time not recorded'} />
          <ul style={{ display: 'flex', gap: 'var(--space-4)', margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none' }}>
            {STAGE_ORDER.map((stage) => (
              <li key={stage} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: `var(${STAGE_VAR[stage]})`, display: 'inline-block' }} />
                {STAGE_LABEL[stage]} {formatDuration(stageTotals[stage])}
              </li>
            ))}
          </ul>
        </Card>

        <Card span={12}>
          <span className="label">Nap</span>
          {lastNight && lastNight.naps.length > 0 ? (
            <p className="basis">
              recorded {lastNight.naps.length === 1 ? 'a nap' : `${lastNight.naps.length} naps`} starting at{' '}
              {lastNight.naps.map((n) => formatClock(n)).join(', ')}, {lastDay?.date}
            </p>
          ) : (
            <EmptyState title="No nap recorded last night."
              detail={lastDay?.worn
                ? `Device was worn on ${lastDay.date}, so this is a real absence rather than missing data.`
                : 'Device was not worn, so no reading exists either way.'} />
          )}
        </Card>

        <Card span={12}>
          <span className="label">Sleep schedule, month</span>
          <p className="basis">bed and wake time, {july.schedule.length} nights, dot marks a nap</p>
          <SleepSchedule nights={july.schedule} />
        </Card>
      </div>
    </>
  )
}
