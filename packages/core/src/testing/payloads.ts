// Shapes come from probe/findings/field-map.md, which records paths and types only. Every value
// here is invented. Real payloads live in a gitignored directory and never enter a fixture.

export interface SamplePointOptions {
  payloadKey: string
  valuePath: string
  value: string | number
  physicalTime: string
  utcOffset?: string
}

const nest = (path: string, value: unknown): Record<string, unknown> => {
  const segments = path.split('.')
  return segments.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>
}

export function samplePoint(o: SamplePointOptions): Record<string, unknown> {
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
    [o.payloadKey]: {
      sampleTime: { physicalTime: o.physicalTime, utcOffset: o.utcOffset ?? '7200s' },
      ...nest(o.valuePath, o.value),
    },
  }
}

export function intervalPoint(o: SamplePointOptions & { endTime: string }): Record<string, unknown> {
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
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

export function sleepPoint(o: {
  name?: string
  startTime: string
  endTime: string
  utcOffset?: string
  stages: SleepStage[]
  mainSleep?: boolean
}): Record<string, unknown> {
  const offset = o.utcOffset ?? '7200s'
  return {
    name: o.name ?? 'users/me/dataTypes/sleep/dataPoints/abc',
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    sleep: {
      interval: {
        startTime: o.startTime, startUtcOffset: offset,
        endTime: o.endTime, endUtcOffset: offset,
      },
      type: 'STAGES',
      metadata: { mainSleep: o.mainSleep ?? true, processed: true, stagesStatus: 'SUCCEEDED' },
      stages: o.stages.map((s) => ({ ...s, startUtcOffset: offset, endUtcOffset: offset })),
    },
  }
}
