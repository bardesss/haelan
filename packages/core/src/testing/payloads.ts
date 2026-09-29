// Shapes come from probe/findings/field-map.md, which records paths and types only. Every value
// here is invented. Real payloads live in a gitignored directory and never enter a fixture.

export interface SamplePointOptions {
  payloadKey: string
  valuePath: string
  value: string | number
  physicalTime: string
  utcOffset?: string
  dataSource?: Record<string, unknown>
}

const nest = (path: string, value: unknown): Record<string, unknown> => {
  const segments = path.split('.')
  return segments.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>
}

export function samplePoint(o: SamplePointOptions): Record<string, unknown> {
  return {
    dataSource: o.dataSource ?? { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
    [o.payloadKey]: {
      sampleTime: { physicalTime: o.physicalTime, utcOffset: o.utcOffset ?? '7200s' },
      ...nest(o.valuePath, o.value),
    },
  }
}

export function intervalPoint(o: SamplePointOptions & { endTime: string }): Record<string, unknown> {
  return {
    dataSource: o.dataSource ?? { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    [o.payloadKey]: {
      interval: {
        startTime: o.physicalTime,
        startUtcOffset: o.utcOffset ?? '7200s',
        endTime: o.endTime,
        endUtcOffset: o.utcOffset ?? '7200s',
      },
      ...nest(o.valuePath, o.value),
    },
  }
}

export function dailyPoint(o: { payloadKey: string, valuePath: string, value: string | number, date: { year: number, month: number, day: number } }): Record<string, unknown> {
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    [o.payloadKey]: { date: o.date, ...nest(o.valuePath, o.value) },
  }
}

export const body = (points: unknown[], nextPageToken?: string): string =>
  JSON.stringify({ dataPoints: points, ...(nextPageToken ? { nextPageToken } : {}) })

export interface SleepStage { type: string, startTime: string, endTime: string }

export interface RollupWindow {
  date: { year: number, month: number, day: number }
  /** The payload key's own object, e.g. { kcalSum: 2500 } or { countSum: '56' }. */
  value: Record<string, unknown>
}

// Exported for seed.ts, which needs the same "one civil day later" arithmetic to close a rollup
// request's own range on the day after its last window, the way client.ts's dailyRollUpDataPoints
// closes its own toLocalDate.
export const nextDay = (d: { year: number, month: number, day: number }) => {
  const ms = Date.UTC(d.year, d.month - 1, d.day) + 86_400_000
  const next = new Date(ms)
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

export const dailyRollupBody = (payloadKey: string, windows: RollupWindow[]): string =>
  JSON.stringify({
    rollupDataPoints: windows.map((w) => ({
      civilStartTime: { date: w.date, time: {} },
      civilEndTime: { date: nextDay(w.date), time: {} },
      [payloadKey]: w.value,
    })),
  })

// The three figures of a provider summary no stage timeline can give. Everything else in the
// summary is worked out from the stages themselves, so the two never disagree about the night.
export interface SleepSummaryInput { minutesToFallAsleep: number, minutesAfterWakeUp: number, awakenings: number }

const minutesBetween = (startTime: string, endTime: string): number =>
  (Date.parse(endTime) - Date.parse(startTime)) / 60_000

// The stored shape (probe/findings/field-map.md's sleep.summary), every number a string the way
// the provider sends int64s. Per-stage minutes and counts come from the stage list; AWAKE's count
// is the caller's instead, because a real night's awakenings are mostly short ones the stage
// list never carries as segments of their own.
function sleepSummaryOf(o: { startTime: string, endTime: string, stages: SleepStage[] }, input: SleepSummaryInput): Record<string, unknown> {
  const types = ['AWAKE', 'LIGHT', 'DEEP', 'REM']
  const minutesOf = (type: string) => Math.round(o.stages.filter((s) => s.type === type)
    .reduce((sum, s) => sum + minutesBetween(s.startTime, s.endTime), 0))
  const countOf = (type: string) => (type === 'AWAKE' ? input.awakenings : o.stages.filter((s) => s.type === type).length)
  const inPeriod = Math.round(minutesBetween(o.startTime, o.endTime))
  const awake = minutesOf('AWAKE')
  return {
    minutesInSleepPeriod: String(inPeriod),
    minutesAsleep: String(inPeriod - awake),
    minutesAwake: String(awake),
    minutesToFallAsleep: String(input.minutesToFallAsleep),
    minutesAfterWakeUp: String(input.minutesAfterWakeUp),
    stagesSummary: types.map((type) => ({ type, minutes: String(minutesOf(type)), count: String(countOf(type)) })),
  }
}

export function sleepPoint(o: {
  name?: string
  startTime: string
  endTime: string
  utcOffset?: string
  stages: SleepStage[]
  mainSleep?: boolean
  dataSource?: Record<string, unknown>
  /** Omitted, the point carries no summary at all, the shape every earlier fixture was built on. */
  summary?: SleepSummaryInput
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '7200s'
  return {
    name: o.name ?? 'users/me/dataTypes/sleep/dataPoints/abc',
    dataSource: o.dataSource ?? { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    sleep: {
      interval: {
        startTime: o.startTime, startUtcOffset: offset,
        endTime: o.endTime, endUtcOffset: offset,
      },
      type: 'STAGES',
      metadata: { mainSleep: o.mainSleep ?? true, processed: true, stagesStatus: 'SUCCEEDED' },
      stages: o.stages.map((s) => ({ ...s, startUtcOffset: offset, endUtcOffset: offset })),
      ...(o.summary ? { summary: sleepSummaryOf(o, o.summary) } : {}),
    },
  }
}
