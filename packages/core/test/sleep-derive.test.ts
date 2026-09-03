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
  // The real shape of the defect, not a contrived one: the provider reports sleep on a 30 second
  // grid, so a night is built of segments that are each an exact half minute long. Ten of those is
  // fifteen minutes. Rounding each one first gives round(1.5) = 2, ten times, which is twenty.
  it('rounds a stage total once rather than rounding every segment into it', () => {
    const half = 90 * 1000
    const segments = Array.from({ length: 10 }, (_, i) =>
      seg('n', 'LIGHT', BEDTIME + i * half, BEDTIME + (i + 1) * half))
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 15 * MIN })], segments)
    expect(valueOf(rows, 'sleep_light_minutes')).toBe(15)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(15)
  })

  // The visible symptom, and the reason this was noticed at all. Before this, rounding four stage
  // figures before dividing could push efficiency over 100 on a short staged session, on 13 real
  // nights, because the numerator gained half a minute per segment and the denominator did not.
  // This test pins that one cause fixed. It is not a universal: overlapping sessions within a
  // night remain a separate, unfixed route to the same over-100 symptom, pinned on its own below
  // ("KNOWN GAP: overlapping sessions within a night double count").
  it('rounding no longer pushes efficiency above 100 on a short staged session', () => {
    const half = 90 * 1000
    const segments = Array.from({ length: 10 }, (_, i) =>
      seg('n', 'LIGHT', BEDTIME + i * half, BEDTIME + (i + 1) * half))
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 15 * MIN })], segments)
    expect(valueOf(rows, 'sleep_efficiency')).toBe(100)

    // The case the name actually promises: a session short enough (7.5 minutes) that the four
    // rounded stage figures gain up to +0.5 minutes each while inBed is rounded only once, so the
    // rounded-figure ratio would clear 100. DEEP, LIGHT and REM each exactly 150 seconds (2.5
    // minutes, Math.round's half-up boundary) round to 3, summing to sleep_asleep_minutes 9 against
    // sleep_in_bed_minutes 8: 9/8 rounds to 113 if efficiency is computed from the rounded minutes
    // instead of from milliseconds.
    const stage = 150 * 1000
    const shortRows = derive([session({ id: 's', startMs: BEDTIME, endMs: BEDTIME + 3 * stage })], [
      seg('s', 'DEEP', BEDTIME, BEDTIME + stage),
      seg('s', 'LIGHT', BEDTIME + stage, BEDTIME + 2 * stage),
      seg('s', 'REM', BEDTIME + 2 * stage, BEDTIME + 3 * stage),
    ])
    expect(valueOf(shortRows, 'sleep_in_bed_minutes')).toBe(8)
    expect(valueOf(shortRows, 'sleep_asleep_minutes')).toBe(9)
    expect(valueOf(shortRows, 'sleep_efficiency')).toBeLessThanOrEqual(100)
  })

  // KNOWN GAP, pinned rather than endorsed, exactly as the mixed-recognition gap above is: a
  // separate route to the same over-100 symptom that the rounding fix above does not touch and
  // this branch does not fix. msByStage sums every segment across the night's sessions without
  // regard for whether their time ranges overlap, so a session nested inside another counts its
  // overlapping span twice. Session 'a' carries LIGHT for the full 8 hours in bed; session 'b',
  // nested inside it, carries DEEP for hour 2 to hour 3. That hour is real time asleep once, but
  // msByStage adds it into both the LIGHT total and the DEEP total, so asleepMs comes out to 9
  // hours (540 minutes) against an 8 hour (480 minute) night, an efficiency of 113. This is not
  // the rounding defect this branch fixed (there is no rounding boundary here at all, the inputs
  // are whole hours), and it was not present in any of the 13 nights audited for this milestone,
  // which is why it is recorded rather than corrected here: deciding whether overlapping in-bed
  // time should count once or twice is a design question about what a night means, not an
  // arithmetic correction, and it is not in scope for this fix wave.
  it('KNOWN GAP: overlapping sessions within a night double count toward asleep and efficiency', () => {
    const rows = derive([
      session({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 8 * H }),
      session({ id: 'b', startMs: BEDTIME + 2 * H, endMs: BEDTIME + 3 * H }),
    ], [
      seg('a', 'LIGHT', BEDTIME, BEDTIME + 8 * H),
      seg('b', 'DEEP', BEDTIME + 2 * H, BEDTIME + 3 * H),
    ])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(540)
    expect(valueOf(rows, 'sleep_efficiency')).toBe(113)
  })

  // The stage figures a reader sees must add up to the asleep figure printed beside them, which is
  // the same rule M3e-2 applied to the insight card delta: a total is derived from its displayed
  // parts, not by re-rounding their sum. Two 2.5 minute segments make the trade-off that buys this
  // visible rather than incidental: the true total is 5 minutes, but summing the already-rounded
  // parts (round(2.5) + round(2.5) = 3 + 3) reports 6, deliberately one minute over. Rounding the
  // summed milliseconds instead (round(5.0) = 5) is the plausible refactor this test exists to
  // catch, and the two disagree here because 2.5 minutes sits exactly on Math.round's half-up
  // boundary. What this trade-off buys is an error bounded by half a minute per stage rather than
  // one that grows with segment count, which is what summing already-rounded segments did.
  it('keeps the stage figures adding up to the asleep figure', () => {
    const stage = 150 * 1000 // 2.5 minutes, exactly on Math.round's rounding boundary
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 2 * stage })], [
      seg('n', 'DEEP', BEDTIME, BEDTIME + stage),
      seg('n', 'LIGHT', BEDTIME + stage, BEDTIME + 2 * stage),
    ])
    const deep = valueOf(rows, 'sleep_deep_minutes')!
    const light = valueOf(rows, 'sleep_light_minutes')!
    expect(deep + light).toBe(valueOf(rows, 'sleep_asleep_minutes'))
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(6)
  })

  // Naps sum session durations rather than segment durations, through the same helper, so they
  // carry the same bias in miniature: of 228 real sleep sessions, 38 rounded up and none down.
  // The two nap sessions land 118.5 minutes apart, inside the 120 minute night gap, so
  // assembleNights groups them together for the purpose of picking the night; that grouping does
  // not merge them into one session, so they still count as two naps summed through asMinutes.
  it('rounds a nap total once as well', () => {
    const half = 90 * 1000
    const rows = derive([
      session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * 60 * MIN }),
      session({ id: 'nap1', startMs: BEDTIME + 20 * 60 * MIN, endMs: BEDTIME + 20 * 60 * MIN + half }),
      session({ id: 'nap2', startMs: BEDTIME + 22 * 60 * MIN, endMs: BEDTIME + 22 * 60 * MIN + half }),
    ], [seg('n', 'LIGHT', BEDTIME, BEDTIME + 8 * 60 * MIN)])
    expect(valueOf(rows, 'sleep_nap_count')).toBe(2)
    expect(valueOf(rows, 'sleep_nap_minutes')).toBe(3)
  })

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

  // The discovery document declares six stage values, not four. The two extra are the classic,
  // non-staged model, and two real nights recorded time in bed with no sleep measurement at all
  // because every segment they had was one of these.
  it('counts an ASLEEP segment as asleep and a RESTLESS segment as awake', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 126 * MIN })], [
      seg('n', 'ASLEEP', BEDTIME, BEDTIME + 116 * MIN),
      seg('n', 'RESTLESS', BEDTIME + 116 * MIN, BEDTIME + 126 * MIN),
    ])
    // The provider's own arithmetic on this exact night: minutesAsleep 116, minutesAwake 10.
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(116)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(10)
  })

  // A classic night is measurable and must stop being treated as unmeasurable. Before this it
  // wrote sleep_in_bed_minutes and nothing else at all.
  it('writes a full measurement for a night made only of classic stages', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 60 * MIN })], [
      seg('n', 'ASLEEP', BEDTIME, BEDTIME + 60 * MIN),
    ])
    // Proves the session reached the night branch (and was not filed as a nap) before trusting
    // the asleep and efficiency figures that follow: a single session on the day is always the
    // only group assembleNights has to choose from, so it lands as the night regardless of its
    // length, but the figures below would only tell us "no measurement" either way if it hadn't.
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(60)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(60)
    expect(valueOf(rows, 'sleep_efficiency')).toBe(100)
    // The night was never staged: it has no DEEP, LIGHT or REM segment at all, so a 0 for any of
    // them would claim a staging measurement came back empty when there was no staging to begin
    // with. Distinct from the case below, where staging happened and genuinely found no REM.
    expect(valueOf(rows, 'sleep_deep_minutes')).toBeUndefined()
    expect(valueOf(rows, 'sleep_light_minutes')).toBeUndefined()
    expect(valueOf(rows, 'sleep_rem_minutes')).toBeUndefined()
  })

  // The other direction: a night that was staged, and genuinely recorded no REM. That 0 is a
  // measurement, not an absence, and must stay a 0 rather than becoming undefined along with the
  // classic case above. What distinguishes the two is not "is every stage present" but "did
  // staging happen at all", i.e. is there at least one DEEP, LIGHT or REM segment.
  it('writes a real zero for a staged stage the night genuinely had none of', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 60 * MIN })], [
      seg('n', 'DEEP', BEDTIME, BEDTIME + 30 * MIN),
      seg('n', 'LIGHT', BEDTIME + 30 * MIN, BEDTIME + 60 * MIN),
    ])
    expect(valueOf(rows, 'sleep_deep_minutes')).toBe(30)
    expect(valueOf(rows, 'sleep_light_minutes')).toBe(30)
    expect(valueOf(rows, 'sleep_rem_minutes')).toBe(0)
  })

  // The guard that predates this stays exactly as it was. A stage outside all six is still
  // outside the vocabulary, and a night made only of those still writes no measurement rather
  // than six zeros, because a zero would claim the person lay awake all night.
  it('still writes no measurement for a night whose stages are outside the vocabulary', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 60 * MIN })], [
      seg('n', 'SOMETHING_NEW', BEDTIME, BEDTIME + 60 * MIN),
    ])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(60)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBeUndefined()
    expect(valueOf(rows, 'sleep_efficiency')).toBeUndefined()
  })

  // KNOWN GAP, pinned rather than endorsed: the recognised.length > 0 gate only asks whether the
  // night has ANY recognised segment, not whether every segment is recognised, so an unrecognised
  // stage mixed into an otherwise-staged night is silently dropped from both totals rather than
  // triggering the all-unknown guard above. 7 hours LIGHT plus 1 hour of a future stage value
  // derives in_bed 480, asleep 420, awake 0: that awake 0 is not a measurement of the unclassified
  // hour, it is what is left over when nobody counted it toward either side, and the three figures
  // do not reconcile (420 asleep + 0 awake != 480 in bed). Whether an unaccounted hour in bed
  // should count as awake, as unmeasured, or as something else is a real design question that this
  // fix wave is not deciding; this test only records today's behaviour so a change to it is a
  // deliberate decision rather than an accident.
  it('KNOWN GAP: an unrecognised stage mixed into a staged night vanishes rather than reconciling', () => {
    const rows = derive([session({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H })], [
      seg('n', 'LIGHT', BEDTIME, BEDTIME + 7 * H),
      seg('n', 'SOMETHING_NEW', BEDTIME + 7 * H, BEDTIME + 8 * H),
    ])
    expect(valueOf(rows, 'sleep_in_bed_minutes')).toBe(480)
    expect(valueOf(rows, 'sleep_asleep_minutes')).toBe(420)
    expect(valueOf(rows, 'sleep_awake_minutes')).toBe(0)
    // 420 + 0 does not equal 480: the unclassified hour is unaccounted for in both totals.
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
