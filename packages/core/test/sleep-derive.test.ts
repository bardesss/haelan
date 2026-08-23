import { describe, expect, it } from 'vitest'
import { deriveSleepDay } from '../src/derive/sleep.ts'
import type { SleepSessionLike, SleepSegmentLike } from '../src/derive/sleep.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

const MIN = 60_000
const H = 60 * MIN
const LOCAL_DATE = '2026-08-22'
const OFFSET = 120
// 23:00 local on 2026-08-21, which is 21:00Z, so the night starts before its own date.
const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)

const session = (o: Partial<SleepSessionLike> & { id: string, startMs: number, endMs: number }): SleepSessionLike => ({
  sourceId: 'watch', startOffsetMinutes: OFFSET, endOffsetMinutes: OFFSET, mainSleep: null, ...o,
})

const seg = (sessionId: string, stage: string, fromMs: number, toMs: number): SleepSegmentLike =>
  ({ sessionId, stage, startMs: fromMs, endMs: toMs })

const derive = (sessions: SleepSessionLike[], segments: SleepSegmentLike[] = []) =>
  deriveSleepDay({
    personId: 'p1', localDate: LOCAL_DATE, source: 'watch', sessions, segments, gapMinutes: 120,
  })

const valueOf = (rows: ReturnType<typeof derive>, metric: string) =>
  rows.find((r) => r.metric === metric)?.value

describe('deriveSleepDay', () => {
  it('writes nothing at all for a day with no sleep', () => {
    expect(derive([])).toEqual([])
  })

  it('sums the stage minutes it was given', () => {
    const rows = derive(
      [session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })],
      [
        seg('n', 'LIGHT', BEDTIME, BEDTIME + 4 * H),
        seg('n', 'DEEP', BEDTIME + 4 * H, BEDTIME + 6 * H),
        seg('n', 'REM', BEDTIME + 6 * H, BEDTIME + 7 * H + 30 * MIN),
        seg('n', 'AWAKE', BEDTIME + 7 * H + 30 * MIN, BEDTIME + 8 * H),
      ],
    )
    expect(valueOf(rows, 'sleep_light_minutes')).toBe(240)
    expect(valueOf(rows, 'sleep_deep_minutes')).toBe(120)
    expect(valueOf(rows, 'sleep_rem_minutes')).toBe(90)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(30)
    // Asleep is the three sleeping stages, never the session's own length: a night with an hour
    // of AWAKE in the middle was not asleep for that hour.
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(450)
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
  })

  it('computes efficiency from what it summed, not from the provider', () => {
    const rows = derive(
      [session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })],
      [
        seg('n', 'LIGHT', BEDTIME, BEDTIME + 6 * H),
        seg('n', 'AWAKE', BEDTIME + 6 * H, BEDTIME + 8 * H),
      ],
    )
    // 360 asleep of 480 in bed.
    expect(valueOf(rows, 'sleep_efficiency')).toBe(75)
  })

  it('counts the gap between two pieces as time awake', () => {
    // The early wake case, in figures. In bed spans both pieces, so the hour spent up counts
    // against efficiency exactly as an AWAKE stage inside one session would.
    const rows = derive(
      [
        session({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 5 * H }),
        session({ id: 'b', startMs: BEDTIME + 6 * H, endMs: BEDTIME + 8 * H }),
      ],
      [
        seg('a', 'LIGHT', BEDTIME, BEDTIME + 5 * H),
        seg('b', 'LIGHT', BEDTIME + 6 * H, BEDTIME + 8 * H),
      ],
    )
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(420)
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(60)
    expect(valueOf(rows, 'sleep_efficiency')).toBe(88)
  })

  it('reports bed and wake times against the local midnight of the row date', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    // Asleep at 23:00 the evening before, up at 07:00 that morning.
    expect(valueOf(rows, 'sleep_bedtime_minutes')).toBe(-60)
    expect(valueOf(rows, 'sleep_waketime_minutes')).toBe(420)
  })

  it('writes the times but no stage figures when the segments never arrived', () => {
    // stagesStatus can say the staging failed. In bed, bedtime and waketime are still known, and
    // a zero for asleep would claim the person lay awake all night.
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_bedtime_minutes')).toBe(-60)
    expect(rows.find((r) => r.metric === 'sleep_asleep_minutes')).toBeUndefined()
    expect(rows.find((r) => r.metric === 'sleep_efficiency')).toBeUndefined()
    expect(rows.find((r) => r.metric === 'sleep_deep_minutes')).toBeUndefined()
  })

  it('counts naps separately from the night', () => {
    const rows = derive([
      session({ id: 'night', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'nap', startMs: BEDTIME + 16 * H, endMs: BEDTIME + 17 * H }),
    ])
    expect(valueOf(rows, 'sleep_nap_count')).toBe(1)
    expect(valueOf(rows, 'sleep_nap_minutes')).toBe(60)
    // The nap is not in the night's span, or in bed would run to the afternoon.
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
  })

  it('writes a zero nap count for a night with no naps, because that is a measurement', () => {
    // Distinct from the no-sleep-at-all day above, which writes nothing. Here we know there were
    // none, and a missing row would read as not knowing.
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    expect(valueOf(rows, 'sleep_nap_count')).toBe(0)
    expect(valueOf(rows, 'sleep_nap_minutes')).toBe(0)
  })

  it('ignores a segment belonging to a session that is not in the night', () => {
    const rows = derive(
      [
        session({ id: 'night', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
        session({ id: 'nap', startMs: BEDTIME + 16 * H, endMs: BEDTIME + 17 * H }),
      ],
      [
        seg('night', 'LIGHT', BEDTIME, BEDTIME + 8 * H),
        seg('nap', 'LIGHT', BEDTIME + 16 * H, BEDTIME + 17 * H),
      ],
    )
    // The nap's hour is reported as a nap, not folded into the night's asleep total.
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(480)
  })

  it('ignores a stage value it does not know rather than guessing where it belongs', () => {
    const rows = derive(
      [session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })],
      [
        seg('n', 'LIGHT', BEDTIME, BEDTIME + 6 * H),
        seg('n', 'SOMETHING_NEW', BEDTIME + 6 * H, BEDTIME + 8 * H),
      ],
    )
    // Counting an unknown stage as asleep would inflate the night; counting it as awake would
    // deflate it. It is neither, and the four measured values are in field-map.md.
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(360)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(0)
  })

  it('files every row under the source it was told, with no mix', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    expect(rows.every((r) => r.source === 'watch')).toBe(true)
    expect(rows.every((r) => r.sourceMix === null)).toBe(true)
    expect(rows.every((r) => r.derivationVersion === DERIVATION_VERSION)).toBe(true)
    expect(rows.every((r) => r.localDate === LOCAL_DATE)).toBe(true)
  })

  it('leaves coverage null, because a night is not measured in hours of the day', () => {
    // coverage means the fraction of the day's hours carrying a sample. A night has no samples
    // underneath it, so any number here would be invented. M2d decides what null means.
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })])
    expect(rows.every((r) => r.coverage === null)).toBe(true)
  })

  it('does not depend on the order the rows arrived in', () => {
    const sessions = [
      session({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 5 * H }),
      session({ id: 'b', startMs: BEDTIME + 6 * H, endMs: BEDTIME + 8 * H }),
    ]
    const segments = [
      seg('a', 'LIGHT', BEDTIME, BEDTIME + 5 * H),
      seg('b', 'DEEP', BEDTIME + 6 * H, BEDTIME + 8 * H),
    ]
    expect(derive([...sessions].reverse(), [...segments].reverse())).toEqual(derive(sessions, segments))
  })
})
