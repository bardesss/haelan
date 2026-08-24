import { describe, expect, it } from 'vitest'
import { deriveSleepDay } from '../src/derive/sleep.ts'
import type { SleepSessionLike, SleepSegmentLike } from '../src/derive/sleep.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { SLEEP_METRICS } from '../src/derive/metrics.ts'

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
  // SLEEP_METRICS says it exists so that this function and the catalogue cannot drift apart on
  // which metrics exist. Nothing enforced that until now: the function pushes literal strings and
  // never reads the list, so a metric added to either side alone left the suite green and the
  // comment false. Equality on a night that reaches every branch is what makes the claim true.
  it('emits exactly the metrics SLEEP_METRICS names, no more and no fewer', () => {
    const rows = derive(
      [
        session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
        session({ id: 'nap', startMs: BEDTIME + 20 * H, endMs: BEDTIME + 21 * H }),
      ],
      [
        seg('n', 'LIGHT', BEDTIME, BEDTIME + 4 * H),
        seg('n', 'DEEP', BEDTIME + 4 * H, BEDTIME + 6 * H),
        seg('n', 'REM', BEDTIME + 6 * H, BEDTIME + 7 * H),
        seg('n', 'AWAKE', BEDTIME + 7 * H, BEDTIME + 8 * H),
      ],
    )
    expect([...new Set(rows.map((r) => r.metric))].sort()).toEqual([...SLEEP_METRICS].sort())
  })

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

  it('assembles a night that arrived in three pieces', () => {
    // Two pieces is the case the concept was invented for; three is what a restless night looks
    // like, and nothing exercised the chain past the first join.
    const rows = derive(
      [
        session({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 3 * H }),
        session({ id: 'b', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 5 * H }),
        session({ id: 'c', startMs: BEDTIME + 6 * H, endMs: BEDTIME + 8 * H }),
      ],
      [
        seg('a', 'LIGHT', BEDTIME, BEDTIME + 3 * H),
        seg('b', 'DEEP', BEDTIME + 4 * H, BEDTIME + 5 * H),
        seg('c', 'REM', BEDTIME + 6 * H, BEDTIME + 8 * H),
      ],
    )
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(360)
    // Both hours between the three pieces are time out of bed.
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(120)
    expect(valueOf(rows, 'sleep_nap_count')).toBe(0)
  })

  it('counts no gap for a piece that overlaps the one before it', () => {
    // A re-reported session can start before the previous one ended. A negative gap subtracted
    // from the awake total would credit the night with time nobody spent asleep.
    const rows = derive(
      [
        session({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 5 * H }),
        session({ id: 'b', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H }),
      ],
      [
        seg('a', 'LIGHT', BEDTIME, BEDTIME + 5 * H),
        seg('b', 'LIGHT', BEDTIME + 5 * H, BEDTIME + 8 * H),
      ],
    )
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(0)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(480)
  })

  it('counts every nap on a day that had several', () => {
    const rows = derive([
      session({ id: 'night', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'earlyNap', startMs: BEDTIME + 13 * H, endMs: BEDTIME + 13 * H + 30 * MIN }),
      session({ id: 'lateNap', startMs: BEDTIME + 17 * H, endMs: BEDTIME + 18 * H }),
    ])
    expect(valueOf(rows, 'sleep_nap_count')).toBe(2)
    expect(valueOf(rows, 'sleep_nap_minutes')).toBe(90)
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
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

  it('writes no stage figures when every segment carries a stage it does not recognise', () => {
    // Six zeros is not the same as no measurement. sleep_asleep_minutes 0 and sleep_efficiency 0
    // are the claim that the person lay awake all night, which is exactly what we do not know
    // when the vocabulary has moved under us.
    const rows = derive(
      [session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })],
      [seg('n', 'SOMETHING_NEW', BEDTIME, BEDTIME + 8 * H)],
    )
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_bedtime_minutes')).toBe(-60)
    expect(valueOf(rows, 'sleep_waketime_minutes')).toBe(420)
    const stageMetrics = [
      'sleep_deep_minutes', 'sleep_light_minutes', 'sleep_rem_minutes',
      'sleep_asleep_minutes', 'sleep_awake_minutes', 'sleep_efficiency',
    ]
    for (const metric of stageMetrics) {
      expect(rows.find((r) => r.metric === metric)).toBeUndefined()
    }
  })

  it('writes no night for a day whose only sleep the source says was not the main sleep', () => {
    // 14:00 to 14:40, flagged false. Promoting it would report a bedtime of 14:00, and a later
    // baseline over a series mixing that with a real bedtime is a band around nothing.
    const rows = derive([
      session({ id: 'afternoon', startMs: BEDTIME + 15 * H, endMs: BEDTIME + 15 * H + 40 * MIN, mainSleep: false }),
    ])
    expect(rows.find((r) => r.metric === 'sleep_in_bed_minutes')).toBeUndefined()
    expect(rows.find((r) => r.metric === 'sleep_bedtime_minutes')).toBeUndefined()
    expect(rows.find((r) => r.metric === 'sleep_waketime_minutes')).toBeUndefined()
    expect(valueOf(rows, 'sleep_nap_count')).toBe(1)
    expect(valueOf(rows, 'sleep_nap_minutes')).toBe(40)
  })

  it('still calls a lone unflagged session the night, because that case is undecidable', () => {
    // The same session with no flag at all. The source declined to say rather than said no, and
    // the longest group is the reasonable guess.
    const rows = derive([
      session({ id: 'afternoon', startMs: BEDTIME + 15 * H, endMs: BEDTIME + 15 * H + 40 * MIN }),
    ])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(40)
    expect(valueOf(rows, 'sleep_bedtime_minutes')).toBe(840)
    expect(valueOf(rows, 'sleep_nap_count')).toBe(0)
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
