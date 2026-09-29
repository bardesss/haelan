// The provider's own sleep summary, stored untouched in attrs.summary. deriveSleepDay sums every
// daily figure from the segments instead; these three are the ones the segments cannot give.
import { numberOrNull } from './workoutSummary.ts'

export interface SleepSummary { minutesToFallAsleep: number | null, minutesAfterWakeUp: number | null, awakenings: number | null }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function sleepSummary(attrs: unknown): SleepSummary {
  const summary = record(record(attrs)?.summary)
  const stages = Array.isArray(summary?.stagesSummary) ? summary.stagesSummary : []
  const awake = stages.map(record).find((stage) => stage?.type === 'AWAKE')
  return {
    minutesToFallAsleep: numberOrNull(summary?.minutesToFallAsleep),
    minutesAfterWakeUp: numberOrNull(summary?.minutesAfterWakeUp),
    awakenings: awake === undefined || awake === null ? null : numberOrNull(awake.count),
  }
}

export function isMainSleep(attrs: unknown): boolean | null {
  const flag = record(attrs)?.mainSleep
  return typeof flag === 'boolean' ? flag : null
}
