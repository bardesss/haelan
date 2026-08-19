import { chartVar, type ChartToken } from '@haelan/tokens'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { july } from '../fixtures/july.js'
import type { Stage } from '../fixtures/july.js'
import { formatClock, formatDuration, toneFor } from '../format.js'
import type { Delta } from '../format.js'

const STAGE_ORDER: Stage[] = ['deep', 'light', 'rem', 'awake']
const STAGE_LABEL: Record<Stage, string> = { deep: 'Deep', light: 'Light', rem: 'REM', awake: 'Awake' }
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
function baselineDelta(minutes: number, low: number, high: number): Delta {
  const range = `the ${formatDuration(low)} to ${formatDuration(high)} baseline`
  const basis = `baseline is this sleeper's own ${formatDuration(low)} to ${formatDuration(high)} range`
  if (minutes < low) return { text: `â†“ below ${range}`, dir: 'down', tone: toneFor('down', 'higher-is-better'), basis }
  if (minutes > high) return { text: `â†‘ above ${range}`, dir: 'up', tone: toneFor('up', 'higher-is-better'), basis }
  return { text: `â†’ within ${range}`, dir: 'flat', tone: toneFor('flat', 'higher-is-better'), basis }
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

        <Card span={8} label="Sleep stages" basis={`last night, ${lastDay?.date ?? 'no date'}, per minute`}>
          <Hypnogram segments={july.hypnogram}
            startLabel={lastNight?.bed != null ? `Bed ${formatClock(lastNight.bed)}` : 'Bed time not recorded'}
            label={`Sleep stages through the night of ${lastDay?.date ?? 'the last recorded night'}`} />
          <ul style={{ display: 'flex', gap: 'var(--space-4)', margin: 'var(--space-2) 0 0', padding: 0, listStyle: 'none' }}>
            {STAGE_ORDER.map((stage) => (
              <li key={stage} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: `var(${chartVar(STAGE_TOKEN[stage])})`, display: 'inline-block' }} />
                {STAGE_LABEL[stage]} {formatDuration(stageTotals[stage])}
              </li>
            ))}
          </ul>
        </Card>

        <Card span={12} label="Nap">
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

        <Card span={12} label="Sleep schedule, month"
          basis={`bed and wake time, ${july.schedule.length} nights, dot marks a nap`}>
          <SleepSchedule nights={july.schedule} label="Bed and wake times for each night of July 2026" />
        </Card>
      </div>
    </>
  )
}
