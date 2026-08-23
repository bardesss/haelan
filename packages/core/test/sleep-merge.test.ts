import { describe, expect, it } from 'vitest'
import { mergeSleepDay } from '../src/derive/sleepMerge.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import type { SleepSessionLike, SleepSegmentLike } from '../src/derive/sleep.ts'

const MIN = 60_000
const H = 60 * MIN
const LOCAL_DATE = '2026-08-22'
const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)

const SOURCES: SourceFacts[] = [
  { id: 'watch', kind: 'device' },
  { id: 'phone', kind: 'app' },
]

const session = (o: Partial<SleepSessionLike> & { id: string, startMs: number, endMs: number }): SleepSessionLike => ({
  sourceId: 'watch', startOffsetMinutes: 120, endOffsetMinutes: 120, mainSleep: null, ...o,
})

const merge = (
  sessions: SleepSessionLike[],
  segments: SleepSegmentLike[] = [],
  lists: Map<string, readonly string[]> = new Map(),
) => mergeSleepDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  sessions,
  segments,
  gapMinutes: 120,
  overlapRatio: 0.5,
  priority: priorityFrom({ lists, sources: SOURCES }),
})

const valueOf = (rows: ReturnType<typeof merge>, metric: string) =>
  rows.find((r) => r.metric === metric)?.value

// Every row of a merged night carries the same mix, so reading it off any one of them is enough.
const mixOf = (rows: ReturnType<typeof merge>): Array<{ source: string, hours: number }> =>
  JSON.parse(rows.find((r) => r.metric === 'sleep_in_bed_minutes')!.sourceMix!)

describe('mergeSleepDay', () => {
  it('files every row it produces under the merged source', () => {
    const rows = merge([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.source === 'merged')).toBe(true)
  })

  it('counts one night once when two sources both recorded it', () => {
    // The corruption this prevents, in its sleep form: sixteen hours in bed on a night somebody
    // slept eight, because a watch and a phone both saw it.
    const rows = merge([
      session({ id: 'w', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'p', sourceId: 'phone', startMs: BEDTIME + 10 * MIN, endMs: BEDTIME + 8 * H }),
    ])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_nap_count')).toBe(0)
  })

  it('lets the priority list decide which recording of the night is used', () => {
    const sessions = [
      session({ id: 'w', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'p', sourceId: 'phone', startMs: BEDTIME, endMs: BEDTIME + 7 * H }),
    ]
    // The fallback ranks the device first, so the watch's eight hours win.
    expect(valueOf(merge(sessions), 'sleep_in_bed_minutes')).toBe(480)
    // Configured the other way, the phone's seven do.
    const lists = new Map<string, readonly string[]>([['sleep', ['phone', 'watch']]])
    expect(valueOf(merge(sessions, [], lists), 'sleep_in_bed_minutes')).toBe(420)
  })

  it('records which sources the merged night drew on', () => {
    const rows = merge([
      session({ id: 'w', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'p', sourceId: 'phone', startMs: BEDTIME + 16 * H, endMs: BEDTIME + 17 * H }),
    ])
    // The watch's night and the phone's nap are different events, so both are primaries and both
    // appear. Hours rather than minutes, because that is what the column means everywhere else.
    expect(mixOf(rows)).toEqual([{ source: 'watch', hours: 8 }, { source: 'phone', hours: 1 }])
  })

  it('keeps an alternate recording out of the figures without deleting it', () => {
    // groupSessions retains the alternate; the merged row simply does not count it. The per
    // source rows deriveSleepDay writes are where the alternate remains visible.
    const rows = merge([
      session({ id: 'w', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'p', sourceId: 'phone', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
    ])
    expect(mixOf(rows)).toEqual([{ source: 'watch', hours: 8 }])
  })

  it('writes nothing for a day with no sleep', () => {
    expect(merge([])).toEqual([])
  })

  it('does not depend on the order the sessions arrived in', () => {
    const sessions = [
      session({ id: 'w', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'p', sourceId: 'phone', startMs: BEDTIME + 16 * H, endMs: BEDTIME + 17 * H }),
    ]
    expect(merge([...sessions].reverse())).toEqual(merge(sessions))
  })
})
