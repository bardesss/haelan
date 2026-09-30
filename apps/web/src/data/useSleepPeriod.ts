import { periodKey } from './usePeriodRead.js'

export { useSleepPeriod } from './usePeriodRead.js'

/** `queryKeys.resource(personId, 'sleep-period')` as the prefix, then the range, anchor and source. */
export function sleepPeriodKey(personId: string, range: string, anchor: string, source: string): readonly unknown[] {
  return periodKey('sleep', personId, range, anchor, source)
}
