import { ConfigError } from '../errors.ts'

/**
 * What an override points at, encoded into the one `target_key` column.
 *
 * Canonical JSON rather than a joined string. rollup.ts already made the argument: a delimiter
 * that can appear in a metric name or a source id is a defect waiting for the first source whose
 * id contains one. Field order is fixed by these builders, which is what keeps the unique index
 * on (person, scope, target_key) a real constraint rather than an approximate one.
 */

export type OverrideScope = 'sample' | 'session' | 'day_metric'

export interface SampleTarget {
  source: string
  metric: string
  utcMs: number
}

export interface DayMetricTarget {
  localDate: string
  metric: string
}

/**
 * Deliberately without `agg`. A person excluding a spike means the reading at that minute, and
 * per minute downsampling wrote it as three rows: excluding only the max would leave two thirds
 * of a reading nobody believes standing.
 */
export function sampleTarget(t: SampleTarget): string {
  return JSON.stringify({ source: t.source, metric: t.metric, utcMs: t.utcMs })
}

export function sessionTarget(sessionId: string): string {
  return JSON.stringify({ session: sessionId })
}

export function dayMetricTarget(t: DayMetricTarget): string {
  return JSON.stringify({ localDate: t.localDate, metric: t.metric })
}

export function parseSampleTarget(key: string): SampleTarget {
  const parsed = decode(key)
  const source = parsed['source']
  const metric = parsed['metric']
  const utcMs = parsed['utcMs']
  if (typeof source !== 'string' || typeof metric !== 'string' || typeof utcMs !== 'number') {
    throw new ConfigError(`sample override target is not a sample target: ${key}`)
  }
  return { source, metric, utcMs }
}

export function parseSessionTarget(key: string): string {
  const session = decode(key)['session']
  if (typeof session !== 'string') {
    throw new ConfigError(`session override target is not a session target: ${key}`)
  }
  return session
}

export function parseDayMetricTarget(key: string): DayMetricTarget {
  const parsed = decode(key)
  const localDate = parsed['localDate']
  const metric = parsed['metric']
  if (typeof localDate !== 'string' || typeof metric !== 'string') {
    throw new ConfigError(`day_metric override target is not a day metric target: ${key}`)
  }
  return { localDate, metric }
}

function decode(key: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch (cause) {
    throw new ConfigError(`override target is not JSON: ${key}`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`override target is not an object: ${key}`)
  }
  return parsed as Record<string, unknown>
}
